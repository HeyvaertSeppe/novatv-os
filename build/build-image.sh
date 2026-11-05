#!/bin/bash
# Builds a flashable NovaTV image (.img.xz for balenaEtcher / Raspberry Pi Imager)
# from the official Raspberry Pi OS Lite 64-bit image.
#
#   sudo ./build/build-image.sh
#
# Needs a Linux machine with: losetup, sfdisk, e2fsprogs, mtools, xz, curl.
# On a non-ARM PC also qemu-user-static with binfmt (the script registers it if missing).
# Environment overrides:
#   BASE_IMG=/path/to/raspios-lite-arm64.img.xz   use a downloaded base image
#   BASE_URL=...                                  download from somewhere else
#   EXTRA_MB=3500                                 extra space for NovaTV packages
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/build/work}"
OUT="${OUT:-$HERE/out}"
BASE_URL="${BASE_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"
EXTRA_MB="${EXTRA_MB:-5000}"
DATE="$(date +%Y%m%d)"
NAME="novatv-os-$DATE"

log() { printf '\n\033[1;36m[build] %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
for t in losetup sfdisk e2fsck resize2fs mcopy xz curl; do
  command -v "$t" >/dev/null || { echo "Missing tool: $t (apt install fdisk e2fsprogs mtools xz-utils curl)" >&2; exit 1; }
done
mkdir -p "$WORK" "$OUT"

# ---------------------------------------------------------------- ARM emulation on x86 hosts
if [ "$(uname -m)" != "aarch64" ]; then
  QEMU="$(command -v qemu-aarch64-static || true)"
  [ -n "$QEMU" ] || { echo "Install qemu-user-static (needed on non-ARM machines)." >&2; exit 1; }
  [ -d /proc/sys/fs/binfmt_misc ] && [ -e /proc/sys/fs/binfmt_misc/register ] || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
  if ! grep -qs enabled /proc/sys/fs/binfmt_misc/qemu-aarch64; then
    echo ":qemu-aarch64:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:$QEMU:F" \
      > /proc/sys/fs/binfmt_misc/register
  fi
fi

# ---------------------------------------------------------------- base image
if [ -z "${BASE_IMG:-}" ]; then
  BASE_IMG="$WORK/base.img.xz"
  if [ ! -s "$BASE_IMG" ]; then
    log "Downloading Raspberry Pi OS Lite (64-bit)"
    curl -fL --retry 3 -o "$BASE_IMG" "$BASE_URL"
  fi
fi
IMG="$WORK/$NAME.img"
log "Unpacking $(basename "$BASE_IMG")"
case "$BASE_IMG" in
  *.xz) xz -dc "$BASE_IMG" > "$IMG" ;;
  *) cp "$BASE_IMG" "$IMG" ;;
esac

# ---------------------------------------------------------------- grow root partition
log "Growing the root partition by ${EXTRA_MB} MB"
truncate -s "+${EXTRA_MB}M" "$IMG"
echo ", +" | sfdisk -N 2 --no-reread "$IMG" >/dev/null
read -r P1_START P1_SIZE < <(sfdisk -d "$IMG" | awk -F'[=,]' '/img1 /{gsub(/ /,""); print $2, $4}')
read -r P2_START < <(sfdisk -d "$IMG" | awk -F'[=,]' '/img2 /{gsub(/ /,""); print $2}')
BOOT_OFF=$((P1_START * 512))
ROOT_OFF=$((P2_START * 512))

LOOP_ROOT="$(losetup -f --show -o "$ROOT_OFF" "$IMG")"
MNT="$WORK/mnt"
mkdir -p "$MNT"
BOOT_MODE=""
LOOP_BOOT=""

cleanup() {
  set +e
  for m in dev/pts dev proc sys run tmp/novatv-src boot/firmware; do
    mountpoint -q "$MNT/$m" && umount -l "$MNT/$m"
  done
  mountpoint -q "$MNT" && umount -l "$MNT"
  [ -n "$LOOP_BOOT" ] && losetup -d "$LOOP_BOOT" 2>/dev/null
  [ -n "${LOOP_ROOT:-}" ] && losetup -d "$LOOP_ROOT" 2>/dev/null
}
trap cleanup EXIT

e2fsck -fy "$LOOP_ROOT" >/dev/null || true
resize2fs "$LOOP_ROOT" >/dev/null
mount "$LOOP_ROOT" "$MNT"

# boot partition: mount it if the kernel can, otherwise copy files in and out with mtools
LOOP_BOOT="$(losetup -f --show -o "$BOOT_OFF" --sizelimit $((P1_SIZE * 512)) "$IMG")"
if mount -t vfat "$LOOP_BOOT" "$MNT/boot/firmware" 2>/dev/null; then
  BOOT_MODE=mount
else
  BOOT_MODE=mtools
  log "vfat not available here, using mtools for the boot partition"
  export MTOOLS_SKIP_CHECK=1
  mcopy -s -n -i "$LOOP_BOOT" ::/* "$MNT/boot/firmware/"
fi

# ---------------------------------------------------------------- chroot
log "Preparing chroot"
mount --bind /dev "$MNT/dev"
mount --bind /dev/pts "$MNT/dev/pts"
mount -t proc proc "$MNT/proc"
mount -t sysfs sys "$MNT/sys"
mount -t tmpfs tmpfs "$MNT/run"
cp "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig"
cat /etc/resolv.conf > "$MNT/etc/resolv.conf" 2>/dev/null || echo "nameserver 1.1.1.1" > "$MNT/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"   # never start services inside the chroot
chmod 755 "$MNT/usr/sbin/policy-rc.d"
mkdir -p "$MNT/tmp/novatv-src"
mount --bind "$HERE" "$MNT/tmp/novatv-src"

# pass the build host's HTTP proxy (if any) to apt in the chroot
PROXY_ENV=()
for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY; do
  [ -n "${!v:-}" ] && PROXY_ENV+=("$v=${!v}")
done

log "Running the NovaTV installer inside the image (takes a while)"
chroot "$MNT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 "${PROXY_ENV[@]}" \
  /bin/bash /tmp/novatv-src/install.sh --chroot

log "Cleaning up the image"
umount "$MNT/tmp/novatv-src"
rm -f "$MNT/usr/sbin/policy-rc.d"
cp "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"
rm -rf "$MNT/tmp/"* "$MNT/var/tmp/"* "$MNT/root/.bash_history" "$MNT/var/cache/apt/archives/"*.deb
for m in run sys proc dev/pts dev; do umount -l "$MNT/$m"; done

if [ "$BOOT_MODE" = mtools ]; then
  log "Writing the boot partition back"
  ( cd "$MNT/boot/firmware" && mcopy -s -o -n -i "$LOOP_BOOT" ./* ::/ )
  rm -rf "${MNT:?}/boot/firmware/"*
else
  umount "$MNT/boot/firmware"
fi
losetup -d "$LOOP_BOOT"; LOOP_BOOT=""

# ---------------------------------------------------------------- shrink
log "Shrinking the image (it grows back to fill the SD card on first boot)"
fstrim -v "$MNT" >/dev/null 2>&1 || true
umount "$MNT"
e2fsck -fy "$LOOP_ROOT" >/dev/null || true
resize2fs -M "$LOOP_ROOT" >/dev/null
BLOCKS="$(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2); print $2}')"
BSIZE="$(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/^Block size/{gsub(/ /,"",$2); print $2}')"
# leave ~256 MB of free space so the first boot has room to work
NEW_BYTES=$((BLOCKS * BSIZE + 256 * 1024 * 1024))
resize2fs "$LOOP_ROOT" $((NEW_BYTES / 1024))K >/dev/null
losetup -d "$LOOP_ROOT"; LOOP_ROOT=""
NEW_SECTORS=$(((NEW_BYTES + 511) / 512))
echo "$P2_START,$NEW_SECTORS" | sfdisk -N 2 --no-reread "$IMG" >/dev/null
truncate -s $(((P2_START + NEW_SECTORS) * 512)) "$IMG"

# ---------------------------------------------------------------- compress
log "Compressing (xz)"
xz -T0 -6 -f "$IMG"
mv "$IMG.xz" "$OUT/"
( cd "$OUT" && sha256sum "$NAME.img.xz" > "$NAME.img.xz.sha256" )
trap - EXIT
log "Done: $OUT/$NAME.img.xz ($(du -h "$OUT/$NAME.img.xz" | cut -f1))"
echo "Flash it with balenaEtcher or Raspberry Pi Imager."
