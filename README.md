# NovaTV OS

A TV operating system for the **Raspberry Pi 5** that looks and feels like Apple TV:
a boot animation, an on-screen setup wizard, a home screen with your streaming apps,
and your **phone as the remote** (scan a QR code, no app needed).

Built on Raspberry Pi OS Lite (64-bit, Debian Trixie) with Chromium, Widevine DRM and
a Wayland kiosk compositor.

## What you get

- **Fast boot with a sharp boot animation** that flows straight into the home screen. The logo is
  drawn at the TV's own resolution (1080p or 4K) by the real display driver, so it's crisp without
  banding, and three small dots show it's still starting. The interface starts as its own system
  service right after the splash, without waiting for Wi-Fi.
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
- **Your TV's own remote** controls NovaTV through HDMI-CEC (arrows, OK, Back/Exit, Home/Menu,
  play/pause, rewind/fast-forward). Switch on CEC in the TV's settings: Anynet+ (Samsung), SimpLink
  (LG), Bravia Sync (Sony), EasyLink (Philips), VIERA Link (Panasonic). Works on either HDMI port.
  NovaTV switches the TV to its input when it starts, pauses playback when the TV is switched off,
  and can turn the TV off or switch it to NovaTV from *Settings → TV Remote* or the phone.
  (HDMI ARC/eARC is for sound from the TV to a soundbar. It works automatically and doesn't
  need anything from NovaTV.)
- **Bluetooth speakers and headphones**: *Settings → Audio & Bluetooth → Bluetooth* on the TV,
  or the **Audio** tab on the phone. Pick the device in pairing mode and NovaTV pairs, trusts and
  connects it, then plays sound on it right away. It reconnects automatically after a restart.
- **Volume** always changes the output that's playing. For Bluetooth speakers that support it
  (almost all), that's the speaker's own volume. A volume pill on the TV shows the level and
  which speaker you're on, also on top of Netflix etc.
- **Equalizer for everything**: every app plays through a system-wide equalizer, so it works in
  Netflix, YouTube, Spotify and any website. Apps that try to play straight to the speaker are
  moved back through the equalizer automatically.
  - 10 bands (31 Hz – 16 kHz, ±12 dB) with a live response curve
  - **DJ isolator** like a Pioneer mixer: LOW / MID / HI knobs from KILL (−26 dB) to +6 dB,
    with KILL buttons on the phone
  - Presets: Flat, Bass Boost, Movie, Dialogue, Music, Night Mode, Loudness, Rock, Electronic,
    Treble Boost, plus your own saved presets
  - Automatic headroom so boosts don't distort
  - On the TV: *Settings → Audio & Bluetooth → Equalizer*. Press OK on a slider or knob, then
    ↑/↓ to change it and ←/→ to move to the next one.
- **Resolution**: *Settings → Resolution* lists every mode your TV reports (4K 60/50/30/25/24 Hz,
  1440p, 1080p, 720p…) plus *Automatic* (the best your TV supports). It switches live; if you don't
  press *Keep* within 15 seconds it goes back, so an unsupported mode can't leave you with a black
  screen. The choice is also used from power-on. At 4K everything renders at 2× sharpness, so the
  interface and all apps keep the same size and layout, just crisper. Default is 1080p 60 Hz,
  the smoothest for navigation on a Pi.
- **Screen saver**: a large clock with seconds and the date, on a very dark, slowly moving
  gradient or plain black (*Settings → Screen Saver → Style*). It drifts slightly every minute
  to protect OLED screens.
- **App Library with 59 services and real logos**, grouped by country: Belgium (Telenet TV, BASE TV,
  VTM GO, VRT MAX, Streamz, Play, Pickx, RTBF Auvio, RTLplay), the Netherlands (NPO Start, Videoland,
  Ziggo GO, KPN TV+, NLZIET, KIJK, SkyShowtime, Pathé), the US (Hulu, Peacock, YouTube TV, Sling, Fubo,
  Tubi, Pluto TV, Paramount+), the UK (BBC iPlayer, ITVX, Channel 4, 5, NOW, U), Germany (ARD, ZDF,
  Joyn, RTL+, WOW, MagentaTV, waipu.tv, Zattoo, DAZN), France (france.tv, TF1+, M6+, CANAL+, Molotov,
  ARTE, RMC+, ADN) and international (Netflix, Prime Video, Disney+, HBO Max, Apple TV, Spotify, Twitch…).
  The Home Screen starts with Netflix, Prime Video and YouTube; add more with the **+ Add Apps** tile.
- **Stremio, the real app**: the native Stremio desktop app (with its own streaming server and the
  mpv player) is built into the image and sits on the Home Screen. It is not the website. The remote
  works in it (arrows, OK, Back = Stremio's back, Play/Pause), the phone remote's **Mouse** mode and
  keyboard work too, and **Home** closes Stremio and returns to NovaTV. NovaTV's on-screen keyboard
  and volume display also appear inside Stremio: NovaTV attaches to Stremio's built-in web view
  (Qt WebEngine's DevTools port, local only) and injects them there.
- **Edit the Home Screen on the TV**: press **Play/Pause** on a tile to move it or take it off.
- **Any website as an app**: *Add Apps → + Website* on the TV, or *Apps → Add App* on the phone.
  The tile shows the name, or a logo you pick from your phone and position/resize.
- Apps open fullscreen without any browser bar. Arrow keys move between links and buttons on every
  site, with a clear focus ring, so websites work with the TV remote like apps.
- **On-screen keyboard** (Apple style) whenever you need to type: in setup, settings and inside apps
  (search, logins). Use the remote arrows and OK; Back closes it; the remote's number buttons type
  digits. You can also type on the phone remote's keyboard.
- **Cooling & Fan** (*Settings → Cooling & Fan*): live CPU temperature, fan speed (RPM) and whether
  the Pi is slowing down because of heat or a weak power supply. The fan on the Pi 5's FAN connector
  (the official Active Cooler, or a case fan) follows a temperature curve: *Quiet* (from 55 °C),
  *Balanced* (from 50 °C, default), *Cool* (from 40 °C) or *Always On*.
- Settings on the TV: Wi-Fi, keyboard layout, screen saver, apps kept in background,
  restart, shut down, about.

## Install

### Option A: flash the ready image (recommended)

1. Get `novatv-os-YYYYMMDD.img.xz` (see *Building the image* below, GitHub Actions builds it for you).
2. Flash it to a microSD card (16 GB or more) with **balenaEtcher** or Raspberry Pi Imager.
   Do not apply Imager's "OS customisation": NovaTV has its own setup.
3. Put the card in the Pi 5, connect HDMI (port 0, next to the USB-C power), plug in a USB
   keyboard and mouse, then power on.
4. The first boot expands the SD card, so it takes a little longer. The setup wizard then appears.

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

## If something goes wrong

- If the interface can't start, NovaTV retries by itself. After several failed tries it shows a
  short message on the TV instead of staying on the boot animation, and keeps retrying.
- Every start writes a report to the SD card's boot partition, in the folder **`novatv-logs`**
  (`boot.txt`; `rescue.txt` when the interface failed). Put the card in any computer to read it.
- `Ctrl+Alt+F2` on a USB keyboard gives a login prompt (user `tv`, password `novatv`).

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
| Kiosk session: `novatv-ui.service` runs `cage` + Chromium on tty1; apps open as tabs controlled over the DevTools port (localhost only) | `rootfs/opt/novatv/bin/`, `rootfs/etc/systemd/system/` |
| HDMI-CEC bridge | `rootfs/opt/novatv/bin/novatv-cec` |
| Audio: outputs, volume, equalizer, Bluetooth | `rootfs/opt/novatv/server/audio.py` |
| Equalizer filter (PipeWire filter-chain) | `rootfs/etc/pipewire/pipewire.conf.d/50-novatv-eq.conf` |
| Boot animation (Plymouth) | `rootfs/usr/share/plymouth/themes/novatv/` (images and script: `tools/render-plymouth.js`) |
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
