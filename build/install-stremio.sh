#!/bin/bash
# Builds the native Stremio desktop app (stremio-shell: Qt 5 + QtWebEngine + mpv, with Stremio's
# streaming server on Node.js) and installs it to /opt/stremio. Called by install.sh.
# Stremio publishes Linux builds for x86 PCs only, so on the Raspberry Pi it is compiled from source.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PREFIX=/opt/stremio
REPO=https://github.com/Stremio/stremio-shell
SERVER_URL_FALLBACK=https://dl.strem.io/server/v4.20.16/desktop/server.js

# libraries/modules Stremio needs at run time (kept)
RUNTIME=(
  qml-module-qtwebengine qml-module-qtwebchannel qml-module-qt-labs-platform qml-module-qt-labs-settings
  qml-module-qtquick-controls qml-module-qtquick-controls2 qml-module-qtquick-dialogs qml-module-qtquick-window2
  qtwayland5 nodejs ca-certificates libmpv2
  wtype wlrctl          # remote control of native apps (virtual keyboard / pointer)
)
# only needed to compile (removed afterwards)
BUILD=(build-essential cmake git wget pkgconf qtbase5-dev qtdeclarative5-dev qtwebengine5-dev libqt5opengl5-dev libmpv-dev libssl-dev)

echo "==> Installing Stremio build dependencies"
apt-get install -y --no-install-recommends "${RUNTIME[@]}" "${BUILD[@]}"

SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
echo "==> Downloading stremio-shell"
git clone --depth 1 --recurse-submodules --shallow-submodules "$REPO" "$SRC/stremio-shell"
cd "$SRC/stremio-shell"

echo "==> Compiling Stremio"
mkdir -p build
( cd build && cmake -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release .. && make -j"$(nproc)" )

echo "==> Installing to $PREFIX"
install -d "$PREFIX"
install -m 755 build/stremio "$PREFIX/stremio"
SERVER_URL="$(cat server-url.txt 2>/dev/null || echo "$SERVER_URL_FALLBACK")"
wget -q -O "$PREFIX/server.js" "$SERVER_URL"
ln -sf "$(command -v node)" "$PREFIX/node"
install -m 644 images/stremio.svg "$PREFIX/stremio.svg" 2>/dev/null || true

# keep every package that provides a library the binary links to, then drop the build tools
owner() {   # package that owns a library (handles /lib vs /usr/lib on merged-/usr systems)
  local f; f="$(realpath "$1")"
  dpkg -S "$f" 2>/dev/null || dpkg -S "/usr${f#/usr}" 2>/dev/null || dpkg -S "${f#/usr}" 2>/dev/null || true
}
mapfile -t LIBPKGS < <(ldd "$PREFIX/stremio" | awk '/=> \//{print $3}' | while read -r l; do owner "$l"; done | cut -d: -f1 | sort -u)
apt-mark manual "${RUNTIME[@]}" "${LIBPKGS[@]}" >/dev/null
apt-get purge -y "${BUILD[@]}" >/dev/null || true
apt-get autoremove -y --purge >/dev/null || true

# check nothing it needs went missing
if ldd "$PREFIX/stremio" | grep -q "not found"; then
  ldd "$PREFIX/stremio" | grep "not found" >&2
  echo "Stremio is missing libraries" >&2
  exit 1
fi
echo "==> Stremio installed: $PREFIX/stremio ($(du -sh "$PREFIX" | cut -f1))"
