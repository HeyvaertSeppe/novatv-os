#!/bin/bash
# Builds Raspberry Pi OS's own cage (the kiosk compositor) with NovaTV's small patch
# (build/patches/cage-novatv.patch) and installs it as /usr/local/bin/cage:
#  - keeps the screen mode the kernel already set, so the TV doesn't re-sync at start
#  - keeps the boot splash up until the interface has drawn its first frame
# The packaged /usr/bin/cage stays installed; NovaTV uses it if this build ever fails.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DEPS="meson ninja-build pkgconf gcc libc6-dev libwlroots-0.20-dev wayland-protocols libwayland-dev \
  libpixman-1-dev libxkbcommon-dev"
POOL="https://archive.raspberrypi.com/debian/pool/main/c/cage"

VER="$(dpkg-query -W -f='${Version}' cage)"
UPSTREAM="${VER%%-*}"
UPSTREAM="${UPSTREAM#*:}"
WORK="$(mktemp -d)"
cleanup() {
  # remove only what was installed for the build, also when the build failed
  if [ -f "$WORK/after" ]; then
    NEW="$(comm -13 "$WORK/before" "$WORK/after")"
    [ -n "$NEW" ] && apt-get purge -y $NEW >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "cage: building $VER with the NovaTV patch"
dpkg-query -W -f='${Package}\n' | sort > "$WORK/before"
apt-get install -y --no-install-recommends $BUILD_DEPS
dpkg-query -W -f='${Package}\n' | sort > "$WORK/after"

cd "$WORK"
curl -fsSL -o orig.tar.xz "$POOL/cage_${UPSTREAM}.orig.tar.xz"
curl -fsSL -o debian.tar.xz "$POOL/cage_${VER/\~/%7E}.debian.tar.xz"
tar xf orig.tar.xz
cd "cage-${UPSTREAM}"
tar xf ../debian.tar.xz
if [ -f debian/patches/series ]; then
  while read -r p; do
    [ -n "$p" ] && [ "${p:0:1}" != "#" ] && patch -p1 -s < "debian/patches/$p"
  done < debian/patches/series
fi
patch -p1 < "$SRC/build/patches/cage-novatv.patch"
meson setup build --buildtype=release -Dman-pages=disabled
ninja -C build
install -m 755 build/cage /usr/local/bin/cage

if ldd /usr/local/bin/cage | grep -q "not found"; then
  echo "cage: patched build is missing libraries, removing it" >&2
  ldd /usr/local/bin/cage | grep "not found" >&2
  rm -f /usr/local/bin/cage
  exit 1
fi
echo "cage: patched build installed in /usr/local/bin/cage"
