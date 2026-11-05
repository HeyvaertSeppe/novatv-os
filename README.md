# NovaTV OS

A TV operating system for the **Raspberry Pi 5** that looks and feels like Apple TV:
a boot animation, an on-screen setup wizard, a home screen with your streaming apps,
and your **phone as the remote** (scan a QR code, no app needed).

Built on Raspberry Pi OS Lite (64-bit, Debian Trixie) with Chromium, Widevine DRM and
a Wayland kiosk compositor.

## What you get

- **Boot animation** that flows into the home screen.
- **First-boot setup on the TV**, driven by a USB keyboard and mouse (or arrow keys):
  Hello → Country (sets time zone, Wi-Fi rules and keyboard layout, e.g. Belgian AZERTY)
  → Wi-Fi (pick a network, type the password) → Name your TV → Pair your phone → Done.
- **Home screen**: real app logos, a top shelf that changes with the focused app,
  parallax tilt, glossy focus and a zoom animation when an app opens.
- **Phone remote** at `http://<the TV's IP>` (the address your router gives it over DHCP).
  The QR code on the TV opens it and pairs it in one step. It has:
  - Touch pad (swipe to move, tap to select), D-pad mode and **mouse mode** (trackpad + scroll)
  - Back, Home, Play/Pause, Volume, Mute
  - **Keyboard**: type on your phone, text appears on the TV (logins, search)
  - Apps tab: launch apps, **add any website as an app**, edit, reorder, delete
  - Settings: name, screen saver, restart, shut down, sign out other phones
- **Your TV's own remote** works too through HDMI-CEC (arrows, OK, back, play/pause).
- Default apps: Netflix, Prime Video, Disney+, Telenet TV, VTM GO, VRT MAX, Streamz, Play,
  YouTube (TV interface), HBO Max, Spotify, Browser.
- Settings on the TV: Wi-Fi, keyboard layout, screen saver, apps kept in background,
  restart, shut down, about.

## Install

### Option A: flash the ready image (recommended)

1. Get `novatv-os-YYYYMMDD.img.xz` (see *Building the image* below, GitHub Actions builds it for you).
2. Flash it to a microSD card (16 GB or more) with **balenaEtcher** or Raspberry Pi Imager.
   Do not apply Imager's "OS customisation": NovaTV has its own setup.
3. Put the card in the Pi 5, connect HDMI (port 0, next to the USB-C power), plug in a USB
   keyboard and mouse, then power on.
4. The first boot expands the SD card and takes about a minute. The setup wizard then appears.

### Option B: install on an existing Raspberry Pi OS Lite

Flash **Raspberry Pi OS Lite (64-bit)**, boot it, then:

```bash
git clone <this repo> novatv && cd novatv
```

```bash
sudo ./install.sh
```

```bash
sudo reboot
```

## Building the image

**On GitHub (easiest):** push this repo to GitHub, open *Actions → Build NovaTV image → Run workflow*.
When it finishes, download the `novatv-os-image` artifact. Pushing a tag such as `v1.0.0`
also attaches the image to a GitHub Release.

**On a Linux PC:**

```bash
sudo apt install fdisk e2fsprogs mtools xz-utils curl qemu-user-static
```

```bash
sudo ./build/build-image.sh
```

The image lands in `out/`. On an ARM64 machine no emulation is needed, so it's much faster.

## Streaming, DRM and video quality

NovaTV uses **Widevine L3**, the only level available on a Raspberry Pi:

- **L1/L2 are not possible on any Raspberry Pi.** They need a hardware secure video path and
  Google certification of the device. No software can add that.
- **Android TV apps** (the Netflix app etc.) refuse to run on uncertified devices, so the apps
  here are the services' **websites** running fullscreen in Chromium with Widevine.

What to expect with L3:

| Service | Works | Max quality (typical) |
| --- | --- | --- |
| Netflix | yes (ChromeOS browser identity) | 720p |
| Prime Video | yes | SD to 720p |
| Disney+ | yes | 720p |
| HBO Max | yes | 720p |
| YouTube (TV interface) | yes, no DRM needed | 1080p |
| VRT MAX, VTM GO, Streamz, Play | yes | depends on the service, usually 720p or higher |
| Telenet TV (telenet.tv) | depends on Telenet's browser support | |

Streaming services change their rules often. If one refuses to play, open the app on your phone
under *Apps → Edit*, and try another **Browser identity** (Standard, ChromeOS, Smart TV, Desktop).

**Codecs:** Chromium includes H.264, VP9, AV1, AAC and Opus decoders. The Pi 5 has no H.264
hardware decoder; its CPU decodes up to 1080p smoothly. The interface runs at **1080p** on purpose:
it keeps navigation smooth even on 4K TVs.

If DRM video never starts, edit `config.txt` on the SD card's boot partition and uncomment
`kernel=kernel8.img` (4K-page kernel), then reboot.

## Network and pairing

- The phone remote is at `http://<IP>` where `<IP>` is the address your router gave the Pi.
  It's shown on the home screen, during setup and in *Settings → Remote*. `http://novatv.local`
  also works on most phones.
- Phones pair with a 6-digit code (the QR code includes it). *Forget All Phones* on the TV signs
  every phone out and creates a new code.

## Accounts

- User `tv`, password `novatv`. SSH is off. To enable it, create an empty file called `ssh`
  on the SD card's boot partition. **Change the password** (`passwd`) if you enable SSH.

## How it works

| Part | Where |
| --- | --- |
| Server (Python, aiohttp): launcher, phone remote, pairing, app list, Wi-Fi, system actions | `rootfs/opt/novatv/server/` |
| TV interface (intro, setup, home, settings) | `rootfs/opt/novatv/web/tv/` |
| Phone remote | `rootfs/opt/novatv/web/remote/` |
| Kiosk session: `cage` + Chromium, apps open as tabs controlled over the DevTools port (localhost only) | `rootfs/opt/novatv/bin/` |
| HDMI-CEC bridge | `rootfs/opt/novatv/bin/novatv-cec` |
| Boot animation (Plymouth) | `rootfs/usr/share/plymouth/themes/novatv/` (frames: `tools/render-plymouth.js`) |
| App tile banners | `rootfs/opt/novatv/web/shared/logos/` (made by `tools/make-banners.py`) |
| Installer / image builder | `install.sh`, `build/build-image.sh` |

Run the interface on a PC for development (no Pi needed):

```bash
pip install aiohttp qrcode
```

```bash
NOVATV_HOME=$PWD/rootfs/opt/novatv NOVATV_STATE=/tmp/novatv NOVATV_PORT=8080 NOVATV_DRY_RUN=1 python3 rootfs/opt/novatv/server/novatv_server.py
```

Then open `http://127.0.0.1:8080/tv/` (TV) and `http://127.0.0.1:8080/?remote` (phone).

## Notes

App names and logos belong to their owners. They're included only so the launcher shows the
apps you open; NovaTV isn't affiliated with any of these services. The Inter font is under the
SIL Open Font License.
