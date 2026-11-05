#!/bin/bash
# NovaTV installer: turns Raspberry Pi OS Lite (64-bit, Trixie) into NovaTV.
#
#   On a Raspberry Pi 5:   sudo ./install.sh          (then reboot)
#   Inside an image build: ./install.sh --chroot      (called by build/build-image.sh)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CHROOT=0
[ "${1:-}" = "--chroot" ] && CHROOT=1
BOOT=/boot/firmware
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }
[ "$(dpkg --print-architecture)" = "arm64" ] || { echo "Needs 64-bit Raspberry Pi OS (arm64)." >&2; exit 1; }

# --------------------------------------------------------------------------- packages
log "Installing packages (Chromium, Widevine, Wayland kiosk, audio, boot splash)"
apt-get update
apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
PKGS=(
  chromium libwidevinecdm0          # browser + Widevine DRM (L3) for Netflix, Prime, Disney+ ...
  cage wlr-randr                    # Wayland kiosk compositor + live resolution switching
  python3-aiohttp python3-qrcode    # NovaTV server
  pipewire pipewire-pulse pipewire-alsa pipewire-bin wireplumber   # audio + the equalizer (filter-chain)
  bluez libspa-0.2-bluetooth        # Bluetooth speakers and headphones (A2DP, absolute volume)
  plymouth plymouth-themes          # boot animation
  v4l-utils                         # cec-ctl: control with the TV's own remote (HDMI-CEC)
  network-manager avahi-daemon sudo curl rfkill iw
  fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
  libgles2 libegl1 mesa-va-drivers ffmpeg   # GPU + codecs (H.264/HEVC/VP9/AV1 via Chromium's FFmpeg)
)
apt-get install -y --no-install-recommends "${PKGS[@]}"
# Raspberry Pi Bluetooth firmware loader (present on Raspberry Pi OS)
apt-get install -y --no-install-recommends pi-bluetooth 2>/dev/null || true

# Stremio: the native desktop app, compiled for the Pi (skip with NOVATV_SKIP_STREMIO=1)
if [ "${NOVATV_SKIP_STREMIO:-0}" != 1 ]; then
  log "Building the Stremio app"
  bash "$SRC/build/install-stremio.sh" || echo "warning: Stremio could not be built; NovaTV works without it"
fi

# Chromium looks for Widevine next to its binary; Raspberry Pi installs it in /opt/WidevineCdm
if [ -d /opt/WidevineCdm ] && [ -d /usr/lib/chromium ] && [ ! -e /usr/lib/chromium/WidevineCdm ]; then
  ln -s /opt/WidevineCdm /usr/lib/chromium/WidevineCdm
fi

# --------------------------------------------------------------------------- user
log "Creating the TV user"
if ! id tv >/dev/null 2>&1; then
  if id pi >/dev/null 2>&1 && [ "$(id -u pi)" -eq 1000 ]; then
    # fresh Raspberry Pi OS image: turn the placeholder "pi" account into "tv"
    usermod -l tv -d /home/tv -m pi
    groupmod -n tv pi
  elif getent passwd 1000 >/dev/null; then
    useradd -m -s /bin/bash tv
  else
    useradd -m -u 1000 -s /bin/bash tv
  fi
fi
usermod -s /bin/bash tv
echo "tv:novatv" | chpasswd
for g in video render audio input netdev plugdev bluetooth; do
  getent group "$g" >/dev/null && usermod -aG "$g" tv
done
TV_UID="$(id -u tv)"
TV_HOME="$(getent passwd tv | cut -d: -f6)"

# skip Raspberry Pi OS's own first-boot user wizard; NovaTV has its own setup on screen
systemctl disable userconfig.service 2>/dev/null || true
systemctl mask userconfig.service 2>/dev/null || true
rm -f "$BOOT/userconf" "$BOOT/userconf.txt"

# --------------------------------------------------------------------------- files
log "Installing NovaTV"
cp -rT "$SRC/rootfs" /
chown -R root:root /opt/novatv /usr/share/plymouth/themes/novatv
chmod 755 /opt/novatv/bin/*
chmod 440 /etc/sudoers.d/novatv
sed -i "s/@UID@/$TV_UID/" /etc/systemd/system/novatv-server.service
install -d -o tv -g tv -m 755 /var/lib/novatv

# the interface runs as a system service on tty1 (novatv-ui.service), not from a login shell
if [ -f "$TV_HOME/.bash_profile" ] && grep -q novatv-session "$TV_HOME/.bash_profile"; then
  rm -f "$TV_HOME/.bash_profile"
fi
rm -rf /etc/systemd/system/getty@tty1.service.d
touch "$TV_HOME/.hushlogin"
mkdir -p "$TV_HOME/.cache" "$TV_HOME/.config"
chown -R tv:tv "$TV_HOME"

# keep the user session (PipeWire audio) alive for the server
mkdir -p /var/lib/systemd/linger
touch /var/lib/systemd/linger/tv

# keyboard starts as US until the setup picks the layout for your country
sed -i 's/^XKBLAYOUT=.*/XKBLAYOUT="us"/' /etc/default/keyboard 2>/dev/null || true

# --------------------------------------------------------------------------- services
log "Enabling services"
systemctl enable novatv-server.service novatv-ui.service novatv-report.timer novatv-cec.service \
  NetworkManager.service avahi-daemon.service bluetooth.service
systemctl disable getty@tty1.service 2>/dev/null || true
systemctl set-default multi-user.target
# cloud-init (Raspberry Pi Imager's customisation) is not used: NovaTV has its own setup.
# Off, it can't recreate the "pi" user or rename the TV, and the first boot is much faster.
mkdir -p /etc/cloud && touch /etc/cloud/cloud-init.disabled
# faster boot: no waiting for the network, no background apt jobs while you watch
systemctl disable NetworkManager-wait-online.service apt-daily.timer apt-daily-upgrade.timer man-db.timer 2>/dev/null || true
systemctl mask systemd-networkd-wait-online.service 2>/dev/null || true

# hostname
echo novatv > /etc/hostname
if grep -q '^127\.0\.1\.1' /etc/hosts; then sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tnovatv/' /etc/hosts
else echo -e '127.0.1.1\tnovatv' >> /etc/hosts; fi

# --------------------------------------------------------------------------- boot
log "Configuring boot (splash, 1080p output, quiet console)"
if [ -f "$BOOT/cmdline.txt" ]; then
  CMD="$BOOT/cmdline.txt"
  sed -i 's/console=tty1/console=tty3/' "$CMD"
  for opt in quiet splash plymouth.ignore-serial-consoles logo.nologo vt.global_cursor_default=0 \
             loglevel=3 consoleblank=0 "video=HDMI-A-1:1920x1080@60" "video=HDMI-A-2:1920x1080@60"; do
    grep -qF -- " $opt" <(echo " $(cat "$CMD")") || sed -i "1 s|\$| $opt|" "$CMD"
  done
  tr -s ' ' < "$CMD" | tr -d '\n' > "$CMD.new" && echo >> "$CMD.new" && mv "$CMD.new" "$CMD"
fi
if [ -f "$BOOT/config.txt" ] && ! grep -q 'NovaTV' "$BOOT/config.txt"; then
  cat >> "$BOOT/config.txt" <<'EOF'

# --- NovaTV ---
[all]
disable_splash=1
disable_overscan=1
boot_delay=0
# If DRM video (Netflix etc.) refuses to play, uncomment the next line to use the 4K-page kernel:
#kernel=kernel8.img
EOF
fi

# fan curve for the Pi 5 fan connector (changeable in Settings -> Cooling & Fan)
if [ "$BOOT" = /boot/firmware ] && [ -f "$BOOT/config.txt" ] && ! grep -q 'NovaTV fan' "$BOOT/config.txt"; then
  NOVATV_FAN_LIVE=0 /opt/novatv/bin/novatv-helper fan balanced >/dev/null || true
fi

# the display driver goes into the initramfs, so the boot animation is drawn by it right
# away in full colour (otherwise Plymouth falls back to a 16-bit framebuffer: banding)
grep -qx vc4 /etc/initramfs-tools/modules 2>/dev/null || echo vc4 >> /etc/initramfs-tools/modules
plymouth-set-default-theme novatv
log "Rebuilding initramfs with the boot animation"
update-initramfs -u -k all || echo "warning: initramfs update failed (boot splash may appear later in boot)"

# --------------------------------------------------------------------------- cleanup
apt-get clean
rm -rf /var/lib/apt/lists/*

log "NovaTV installed."
if [ "$CHROOT" -eq 0 ]; then
  echo "Reboot to start NovaTV:  sudo reboot"
fi
