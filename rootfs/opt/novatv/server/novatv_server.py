#!/usr/bin/env python3
"""NovaTV background server.

- Serves the TV launcher (http://127.0.0.1/tv/) and the phone remote (http://<ip>/).
- Pairs phones with a 6-digit code (shown on the TV as a QR code).
- Drives the kiosk Chromium over the DevTools protocol: opens apps as tabs,
  sends remote key presses, mouse pointer, text, back/home, play/pause.
- Handles first-boot setup (country, Wi-Fi, device name) and system actions.
"""
import asyncio
import io
import json
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

from aiohttp import ClientSession, WSMsgType, web

from audio import Audio, Bluetooth

try:
    import qrcode
    import qrcode.image.svg
except ImportError:  # QR codes are generated in the browser as a fallback
    qrcode = None

VERSION = "1.0.0"
HOME = Path(os.environ.get("NOVATV_HOME", "/opt/novatv"))
STATE_DIR = Path(os.environ.get("NOVATV_STATE", "/var/lib/novatv"))
PORT = int(os.environ.get("NOVATV_PORT", "80"))
CDP_HOST = os.environ.get("NOVATV_CDP", "127.0.0.1:9222")
DRY_RUN = os.environ.get("NOVATV_DRY_RUN") == "1"  # dev mode: no system commands
HELPER = ["sudo", "-n", str(HOME / "bin" / "novatv-helper")]
LAUNCHER_PATH = "/tv/"

log = logging.getLogger("novatv")

UA_PRESETS = {
    "chromeos": "Mozilla/5.0 (X11; CrOS aarch64 16181.61.0) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/{ver} Safari/537.36",
    "smarttv": "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 "
               "(KHTML, like Gecko) {ver}/7.0 TV Safari/537.36",
    "desktop": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/{ver} Safari/537.36",
}

COUNTRIES = {  # code: (name, timezone)
    "BE": ("Belgium", "Europe/Brussels"), "NL": ("Netherlands", "Europe/Amsterdam"),
    "LU": ("Luxembourg", "Europe/Luxembourg"), "FR": ("France", "Europe/Paris"),
    "DE": ("Germany", "Europe/Berlin"), "GB": ("United Kingdom", "Europe/London"),
    "IE": ("Ireland", "Europe/Dublin"), "ES": ("Spain", "Europe/Madrid"),
    "PT": ("Portugal", "Europe/Lisbon"), "IT": ("Italy", "Europe/Rome"),
    "CH": ("Switzerland", "Europe/Zurich"), "AT": ("Austria", "Europe/Vienna"),
    "DK": ("Denmark", "Europe/Copenhagen"), "SE": ("Sweden", "Europe/Stockholm"),
    "NO": ("Norway", "Europe/Oslo"), "FI": ("Finland", "Europe/Helsinki"),
    "PL": ("Poland", "Europe/Warsaw"), "US": ("United States", "America/New_York"),
    "CA": ("Canada", "America/Toronto"), "AU": ("Australia", "Australia/Sydney"),
}

# keyboard layout that matches each country (applied to USB keyboards)
COUNTRY_KB = {
    "BE": "be", "NL": "us", "LU": "fr", "FR": "fr", "DE": "de", "GB": "gb", "IE": "ie", "ES": "es",
    "PT": "pt", "IT": "it", "CH": "ch", "AT": "at", "DK": "dk", "SE": "se", "NO": "no", "FI": "fi",
    "PL": "pl", "US": "us", "CA": "us", "AU": "us",
}
KB_LAYOUTS = {"be": "Belgian (AZERTY)", "us": "English (US)", "gb": "English (UK)", "fr": "French (AZERTY)",
              "de": "German (QWERTZ)", "nl": "Dutch", "es": "Spanish", "it": "Italian", "ch": "Swiss",
              "pt": "Portuguese", "at": "Austrian", "dk": "Danish", "se": "Swedish", "no": "Norwegian",
              "fi": "Finnish", "pl": "Polish", "ie": "Irish"}

# key name -> (key, code, windowsVirtualKeyCode, text)
KEYS = {
    "up": ("ArrowUp", "ArrowUp", 38, ""), "down": ("ArrowDown", "ArrowDown", 40, ""),
    "left": ("ArrowLeft", "ArrowLeft", 37, ""), "right": ("ArrowRight", "ArrowRight", 39, ""),
    "select": ("Enter", "Enter", 13, "\r"), "enter": ("Enter", "Enter", 13, "\r"),
    "escape": ("Escape", "Escape", 27, ""), "backspace": ("Backspace", "Backspace", 8, ""),
    "space": (" ", "Space", 32, " "), "tab": ("Tab", "Tab", 9, ""),
    "pageup": ("PageUp", "PageUp", 33, ""), "pagedown": ("PageDown", "PageDown", 34, ""),
    "f": ("f", "KeyF", 70, "f"),
    "mediaplaypause": ("MediaPlayPause", "MediaPlayPause", 179, ""),
}


# --------------------------------------------------------------------------- utils

def run(cmd, timeout=20):
    """Run a command, return (returncode, stdout). Never raises."""
    if DRY_RUN:
        log.info("dry-run: %s", " ".join(cmd))
        return 0, ""
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        if p.returncode:
            log.warning("%s -> %s %s", cmd, p.returncode, p.stderr.strip()[:300])
        return p.returncode, p.stdout
    except Exception as e:  # noqa: BLE001
        log.warning("%s failed: %s", cmd, e)
        return 1, ""


async def arun(cmd, timeout=20):
    return await asyncio.to_thread(run, cmd, timeout)


def get_ip():
    """The address the router gave us (DHCP), as phones on the LAN see it."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        ip = s.getsockname()[0]
        if not ip.startswith("127."):
            return ip
    except OSError:
        pass
    finally:
        s.close()
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout
        for ip in out.split():
            if "." in ip and not ip.startswith("127."):
                return ip
    except Exception:  # noqa: BLE001
        pass
    return None


def qr_svg(data):
    if not qrcode:
        return None
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------- state

class State:
    def __init__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = STATE_DIR / "state.json"
        data = {}
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text())
            except Exception:  # noqa: BLE001
                log.exception("state.json unreadable, starting fresh")
        defaults = json.loads((HOME / "server" / "default-apps.json").read_text())
        self.apps = data.get("apps") or defaults
        s = data.get("settings", {})
        self.settings = {
            "setup_done": s.get("setup_done", False),
            "device_name": s.get("device_name", "NovaTV"),
            "country": s.get("country", ""),
            "keyboard": s.get("keyboard", "us"),
            "setup_resume": s.get("setup_resume", ""),
            "screensaver_minutes": s.get("screensaver_minutes", 5),
            "screensaver_style": s.get("screensaver_style", "gradient"),
            "display": s.get("display", "1920x1080@60"),
            "cec_enabled": s.get("cec_enabled", True),
            "cec_autoswitch": s.get("cec_autoswitch", True),
            "keep_background": s.get("keep_background", 1),
            "pair_code": s.get("pair_code") or f"{secrets.randbelow(10**6):06d}",
            "token": s.get("token") or secrets.token_urlsafe(32),
        }
        self.save()

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"apps": self.apps, "settings": self.settings}, indent=2))
        tmp.replace(self.path)

    def app(self, app_id):
        return next((a for a in self.apps if a["id"] == app_id), None)

    def public_settings(self):
        s = {k: v for k, v in self.settings.items() if k not in ("token", "pair_code")}
        return s


# --------------------------------------------------------------------------- browser

class Browser:
    """Controls the kiosk Chromium via one flat-mode DevTools websocket."""

    def __init__(self, server):
        self.srv = server
        self.ws = None
        self.msg_id = 0
        self.pending = {}
        self.sessions = {}      # targetId -> sessionId
        self.targets = {}       # targetId -> targetInfo
        self.app_tabs = {}      # appId -> targetId  (insertion order = LRU)
        self.tab_app = {}       # targetId -> appId
        self.launcher = None    # targetId of the launcher tab
        self.active = None      # targetId currently on screen
        self.version = "156.0.0.0"
        self.pointer = {}       # targetId -> [x, y]
        self.connected = asyncio.Event()
        self.inject_js = (HOME / "inject" / "inject.js").read_text()

    @property
    def ok(self):
        return self.ws is not None and not self.ws.closed

    async def run_forever(self):
        async with ClientSession() as http:
            while True:
                try:
                    async with http.get(f"http://{CDP_HOST}/json/version", timeout=3) as r:
                        info = await r.json(content_type=None)
                    self.version = info.get("Browser", "Chrome/156.0.0.0").split("/")[-1]
                    async with http.ws_connect(info["webSocketDebuggerUrl"], max_msg_size=0) as ws:
                        self.ws = ws
                        log.info("connected to Chromium %s", self.version)
                        reader = asyncio.create_task(self._reader())
                        await self._on_connect()
                        self.connected.set()
                        await reader
                except (OSError, asyncio.TimeoutError, KeyError) as e:
                    log.debug("chromium not reachable: %s", e)
                except Exception:  # noqa: BLE001
                    log.exception("browser loop")
                finally:
                    self.ws = None
                    self.connected.clear()
                    for f in self.pending.values():
                        if not f.done():
                            f.cancel()
                    self.pending.clear()
                    self.sessions.clear()
                    self.targets.clear()
                    self.app_tabs.clear()
                    self.tab_app.clear()
                    self.launcher = self.active = None
                await asyncio.sleep(1.5)

    async def _reader(self):
        async for msg in self.ws:
            if msg.type != WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            if "id" in data:
                fut = self.pending.pop(data["id"], None)
                if fut and not fut.done():
                    if "error" in data:
                        fut.set_exception(RuntimeError(data["error"].get("message")))
                    else:
                        fut.set_result(data.get("result", {}))
            else:
                try:
                    await self._on_event(data.get("method"), data.get("params", {}))
                except Exception:  # noqa: BLE001
                    log.exception("event %s", data.get("method"))

    async def call(self, method, params=None, session=None, timeout=10):
        if not self.ok:
            raise RuntimeError("browser not connected")
        self.msg_id += 1
        mid = self.msg_id
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        await self.ws.send_str(json.dumps(msg))
        return await asyncio.wait_for(fut, timeout)

    async def _on_connect(self):
        await self.call("Target.setDiscoverTargets", {"discover": True})
        res = await self.call("Target.getTargets")
        for t in res["targetInfos"]:
            if t["type"] != "page":
                continue
            self.targets[t["targetId"]] = t
            if LAUNCHER_PATH in t["url"] and self.launcher is None:
                self.launcher = t["targetId"]
            else:
                # tabs from a previous server run: we lost their settings, close them
                await self.call("Target.closeTarget", {"targetId": t["targetId"]})
        if self.launcher is None:
            r = await self.call("Target.createTarget", {"url": f"http://127.0.0.1:{PORT}{LAUNCHER_PATH}"})
            self.launcher = r["targetId"]
        await self._attach(self.launcher, inject=False)
        await self.activate(self.launcher)

    async def _attach(self, tid, inject=True, ua=None):
        r = await self.call("Target.attachToTarget", {"targetId": tid, "flatten": True})
        sid = r["sessionId"]
        self.sessions[tid] = sid
        await self.call("Page.enable", session=sid)
        if ua:
            await self._set_ua(sid, ua)
        if inject:
            await self.call("Page.addScriptToEvaluateOnNewDocument", {"source": self.inject_js}, sid)
        return sid

    async def _set_ua(self, sid, preset):
        tpl = UA_PRESETS.get(preset)
        if not tpl:
            return
        major = self.version.split(".")[0]
        params = {"userAgent": tpl.format(ver=self.version)}
        if preset == "chromeos":
            params["platform"] = "Linux aarch64"
            params["userAgentMetadata"] = {
                "brands": [{"brand": "Chromium", "version": major},
                           {"brand": "Google Chrome", "version": major},
                           {"brand": "Not.A/Brand", "version": "24"}],
                "fullVersion": self.version, "platform": "Chrome OS",
                "platformVersion": "16181.61.0", "architecture": "arm", "model": "",
                "mobile": False, "bitness": "64",
            }
        await self.call("Emulation.setUserAgentOverride", params, sid)

    async def _on_event(self, method, p):
        if method == "Target.targetCreated":
            t = p["targetInfo"]
            if t["type"] == "page":
                self.targets[t["targetId"]] = t
                opener = t.get("openerId")
                if opener and opener in self.tab_app and t["targetId"] not in self.sessions:
                    # popup (e.g. "sign in with Google") opened by an app: follow it
                    self.tab_app[t["targetId"]] = self.tab_app[opener]
                    app = self.srv.state.app(self.tab_app[opener]) or {}
                    try:
                        await self._attach(t["targetId"], ua=app.get("ua"))
                    except Exception:  # noqa: BLE001
                        pass
                    self.active = t["targetId"]
        elif method == "Target.targetInfoChanged":
            t = p["targetInfo"]
            if t["targetId"] in self.targets:
                self.targets[t["targetId"]] = t
        elif method == "Target.targetDestroyed":
            await self._forget(p["targetId"])
        elif method == "Target.targetCrashed":
            tid = p["targetId"]
            log.warning("tab crashed: %s", self.targets.get(tid, {}).get("url"))
            if tid == self.launcher:
                await self.call("Target.closeTarget", {"targetId": tid})
            else:
                await self.srv.toast("The app stopped unexpectedly")
                await self.call("Target.closeTarget", {"targetId": tid})
        elif method == "Target.detachedFromTarget":
            tid = p.get("targetId")
            if tid and self.sessions.get(tid) == p.get("sessionId"):
                self.sessions.pop(tid, None)

    async def _forget(self, tid):
        info = self.targets.pop(tid, None)
        self.sessions.pop(tid, None)
        self.pointer.pop(tid, None)
        app_id = self.tab_app.pop(tid, None)
        if app_id and self.app_tabs.get(app_id) == tid:
            self.app_tabs.pop(app_id, None)
        if tid == self.launcher:
            self.launcher = None
            r = await self.call("Target.createTarget", {"url": f"http://127.0.0.1:{PORT}{LAUNCHER_PATH}"})
            self.launcher = r["targetId"]
            await self._attach(self.launcher, inject=False)
            await self.activate(self.launcher)
        elif tid == self.active:
            opener = (info or {}).get("openerId")
            if opener and opener in self.targets:
                await self.activate(opener)
            else:
                await self.go_home()

    async def activate(self, tid):
        await self.call("Target.activateTarget", {"targetId": tid})
        self.active = tid
        await self.srv.broadcast_state()

    @property
    def active_app(self):
        if self.active and self.active != self.launcher:
            return self.tab_app.get(self.active)
        return None

    # ---- app lifecycle
    async def launch(self, app):
        app_id = app["id"]
        tid = self.app_tabs.get(app_id)
        if tid and tid in self.targets:
            sid = self.sessions.get(tid)
            self.app_tabs.pop(app_id)
            self.app_tabs[app_id] = tid  # mark most recently used
            if sid:
                try:
                    await self.call("Page.setWebLifecycleState", {"state": "active"}, sid)
                except Exception:  # noqa: BLE001
                    pass
            await self.activate(tid)
            return
        await self._trim_background(max(0, int(self.srv.state.settings["keep_background"])))
        r = await self.call("Target.createTarget", {"url": "about:blank"})
        tid = r["targetId"]
        self.app_tabs[app_id] = tid
        self.tab_app[tid] = app_id
        sid = await self._attach(tid, ua=app.get("ua"))
        await self.call("Page.navigate", {"url": app["url"]}, sid)
        await self.activate(tid)

    async def _trim_background(self, keep):
        """Keep at most `keep` apps alive in the background, close the oldest."""
        alive = [a for a, t in self.app_tabs.items() if t in self.targets]
        while len(alive) > keep:
            old = alive.pop(0)
            tid = self.app_tabs.pop(old, None)
            if tid:
                try:
                    await self.call("Target.closeTarget", {"targetId": tid})
                except Exception:  # noqa: BLE001
                    pass

    async def go_home(self):
        cur = self.active
        if cur and cur != self.launcher and cur in self.sessions:
            sid = self.sessions[cur]
            try:
                await self.call("Runtime.evaluate", {"expression":
                    "document.querySelectorAll('video,audio').forEach(m=>{try{m.pause()}catch(e){}});"
                    "document.fullscreenElement&&document.exitFullscreen().catch(()=>{});"}, sid, timeout=2)
            except Exception:  # noqa: BLE001
                pass
        if self.launcher:
            await self.activate(self.launcher)
        keep = int(self.srv.state.settings["keep_background"])
        await self._trim_background(keep)
        # freeze the background app so it uses no CPU while you browse the home screen
        if cur and cur != self.launcher and cur in self.sessions and keep > 0:
            try:
                await self.call("Page.setWebLifecycleState", {"state": "frozen"}, self.sessions[cur], timeout=3)
            except Exception:  # noqa: BLE001
                pass

    # ---- input
    def _sid(self):
        return self.sessions.get(self.active)

    async def press(self, name):
        sid = self._sid()
        if not sid or name not in KEYS:
            return
        key, code, vk, text = KEYS[name]
        down = {"type": "keyDown" if text else "rawKeyDown", "key": key, "code": code,
                "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
        if text:
            down["text"] = down["unmodifiedText"] = text
        await self.call("Input.dispatchKeyEvent", down, sid)
        await self.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": code,
                                                   "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}, sid)

    async def insert_text(self, text):
        sid = self._sid()
        if sid and text:
            await self.call("Input.insertText", {"text": text}, sid)

    async def evaluate(self, expr, sid=None):
        sid = sid or self._sid()
        if not sid:
            return None
        r = await self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, sid, timeout=4)
        return r.get("result", {}).get("value")

    async def back(self):
        if self.active == self.launcher:
            await self.press("escape")
            return
        app = self.srv.state.app(self.active_app or "") or {}
        mode = app.get("back", "smart")
        if mode == "escape":
            await self.press("escape")
            return
        sid = self._sid()
        was_fs = await self.evaluate(
            "document.fullscreenElement?(document.exitFullscreen().catch(()=>{}),true):false")
        if was_fs:
            return
        hist = await self.call("Page.getNavigationHistory", session=sid)
        idx, entries = hist["currentIndex"], hist["entries"]
        if idx > 0 and entries[idx - 1]["url"] != "about:blank":
            await self.call("Page.navigateToHistoryEntry", {"entryId": entries[idx - 1]["id"]}, sid)
        else:
            await self.go_home()

    async def play_pause(self):
        if self.active == self.launcher:
            await self.press("select")
            return
        done = await self.evaluate("""(()=>{const v=[...document.querySelectorAll('video')]
            .filter(v=>v.readyState>0).sort((a,b)=>b.clientWidth-a.clientWidth)[0];
            if(!v)return false; v.paused?v.play():v.pause(); return true})()""")
        if not done:
            await self.press("space")

    async def _viewport(self, sid):
        m = await self.call("Page.getLayoutMetrics", session=sid)
        vp = m.get("cssVisualViewport") or m.get("layoutViewport")
        return vp.get("clientWidth", 1920), vp.get("clientHeight", 1080)

    async def pointer_move(self, dx, dy):
        sid = self._sid()
        if not sid:
            return
        w, h = await self._viewport(sid)
        x, y = self.pointer.get(self.active, [w / 2, h / 2])
        x = min(max(0, x + dx), w - 1)
        y = min(max(0, y + dy), h - 1)
        self.pointer[self.active] = [x, y]
        await self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y}, sid)

    async def pointer_click(self):
        sid = self._sid()
        if not sid:
            return
        w, h = await self._viewport(sid)
        x, y = self.pointer.get(self.active, [w / 2, h / 2])
        for t in ("mousePressed", "mouseReleased"):
            await self.call("Input.dispatchMouseEvent",
                            {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1}, sid)

    async def pointer_scroll(self, dx, dy):
        sid = self._sid()
        if not sid:
            return
        w, h = await self._viewport(sid)
        x, y = self.pointer.get(self.active, [w / 2, h / 2])
        await self.call("Input.dispatchMouseEvent",
                        {"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy}, sid)

    async def hud(self, kind, value):
        """Show the volume / toast overlay inside the app that is on screen."""
        if self.active and self.active != self.launcher:
            try:
                await self.evaluate(f"window.__novatv&&window.__novatv.hud({json.dumps(kind)},{json.dumps(value)})")
            except Exception:  # noqa: BLE001
                pass


# --------------------------------------------------------------------------- server

class Server:
    def __init__(self):
        self.state = State()
        self.browser = Browser(self)
        self.clients = {}   # ws -> role ("tv" | "remote")
        self.ip = get_ip()
        self.fail = {}      # ip -> (count, until)
        self.audio = Audio(self)
        self.bt = Bluetooth(self)

    # ---- auth helpers
    @staticmethod
    def is_local(req):
        return req.remote in ("127.0.0.1", "::1")

    def authorized(self, req):
        if self.is_local(req):
            return True
        tok = req.cookies.get("novatv_token") or req.headers.get("X-NovaTV-Token")
        return bool(tok) and secrets.compare_digest(tok, self.state.settings["token"])

    def require_auth(self, req):
        if not self.authorized(req):
            raise web.HTTPUnauthorized(text=json.dumps({"error": "pair"}), content_type="application/json")

    def require_local(self, req):
        if not self.is_local(req) and not (self.authorized(req) and self.state.settings["setup_done"]):
            raise web.HTTPForbidden()

    def check_code(self, req, code):
        ip = req.remote
        count, until = self.fail.get(ip, (0, 0))
        if until > time.time():
            return "locked"
        if code and secrets.compare_digest(str(code).strip(), self.state.settings["pair_code"]):
            self.fail.pop(ip, None)
            return "ok"
        count += 1
        self.fail[ip] = (count, time.time() + 300 if count >= 8 else 0)
        return "bad"

    def set_token_cookie(self, resp):
        resp.set_cookie("novatv_token", self.state.settings["token"], max_age=10 * 365 * 86400,
                        httponly=True, samesite="Lax", path="/")

    def urls(self):
        host = self.ip or "novatv.local"
        base = f"http://{host}" + ("" if PORT == 80 else f":{PORT}")
        return base, f"{base}/pair?code={self.state.settings['pair_code']}"

    def info(self, local):
        base, pair = self.urls()
        d = {
            "version": VERSION, "ip": self.ip, "url": base, "hostname": socket.gethostname(),
            "browser": self.browser.ok, "active_app": self.browser.active_app,
            "volume": self.audio.volume, "remotes": sum(1 for r in self.clients.values() if r == "remote"),
            "settings": self.state.public_settings(),
        }
        if local:
            d["pair_code"] = self.state.settings["pair_code"]
            d["pair_url"] = pair
        return d

    # ---- websocket broadcast
    async def send(self, ws, msg):
        try:
            await ws.send_str(json.dumps(msg))
        except Exception:  # noqa: BLE001
            pass

    async def broadcast(self, msg, role=None):
        for ws, r in list(self.clients.items()):
            if role is None or r == role:
                await self.send(ws, msg)

    async def broadcast_state(self):
        await self.broadcast({"t": "state", "active_app": self.browser.active_app,
                              "volume": self.audio.volume, "ip": self.ip,
                              "remotes": sum(1 for r in self.clients.values() if r == "remote")})

    async def toast(self, text):
        await self.broadcast({"t": "toast", "text": text}, role="tv")
        await self.browser.hud("toast", text)

    # ---- actions shared by HTTP + websocket
    async def launch(self, app_id):
        app = self.state.app(app_id)
        if not app:
            return
        if app.get("type") == "system":
            if self.browser.ok and self.browser.active != self.browser.launcher:
                await self.browser.go_home()
            await self.broadcast({"t": "open", "screen": app_id}, role="tv")
            return
        if not self.browser.ok:
            await self.toast("Browser is starting, try again in a moment")
            return
        if self.browser.active == self.browser.launcher:
            await self.broadcast({"t": "launching", "id": app_id}, role="tv")
            await asyncio.sleep(0.42)  # let the zoom animation play
        await self.browser.launch(app)
        await self.broadcast_state()

    async def home(self):
        if self.browser.ok and self.browser.active != self.browser.launcher:
            await self.browser.go_home()
            await self.broadcast({"t": "home", "from": None}, role="tv")
        else:
            await self.broadcast({"t": "home"}, role="tv")

    async def remote_input(self, m):
        t = m.get("t")
        b = self.browser
        on_launcher = not b.ok or b.active == b.launcher
        if t == "key":
            k = m.get("k")
            if k == "home":
                await self.home()
            elif k == "standby":
                # the TV was switched off: pause whatever plays
                if b.ok and b.active != b.launcher:
                    try:
                        await b.evaluate("document.querySelectorAll('video,audio').forEach(m=>{try{m.pause()}catch(e){}})")
                    except Exception:  # noqa: BLE001
                        pass
            elif k == "back":
                if b.ok:
                    await b.back()
                else:
                    await self.broadcast({"t": "key", "k": "back"}, role="tv")
            elif k == "playpause":
                await (b.play_pause() if b.ok else self.broadcast({"t": "key", "k": "select"}, role="tv"))
            elif k in ("volup", "voldown", "mute"):
                await self.audio.change_volume(k)
            elif k in KEYS:
                if b.ok:
                    await b.press(k)
                elif on_launcher:
                    await self.broadcast({"t": "key", "k": k}, role="tv")
        elif t == "volume_set":
            await self.audio.change_volume("set", m.get("level", 50))
        elif t == "eq":
            self.audio.set_eq(m)
        elif t == "text" and b.ok:
            await b.insert_text(str(m.get("text", ""))[:500])
        elif t == "pointer" and b.ok:
            await b.pointer_move(float(m.get("dx", 0)), float(m.get("dy", 0)))
        elif t == "click" and b.ok:
            await b.pointer_click()
        elif t == "scroll" and b.ok:
            await b.pointer_scroll(float(m.get("dx", 0)), float(m.get("dy", 0)))

    # ---- HTTP handlers
    async def h_root(self, req):
        if self.is_local(req) and "remote" not in req.query:
            raise web.HTTPFound(LAUNCHER_PATH)
        return self.static_file("remote/index.html")

    def static_file(self, rel):
        resp = web.FileResponse(HOME / "web" / rel)
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    async def h_tv_redirect(self, req):
        raise web.HTTPFound("/tv/")

    async def h_tv(self, req):
        return self.static_file("tv/index.html")

    async def h_pair_get(self, req):
        res = self.check_code(req, req.query.get("code"))
        if res == "ok":
            resp = web.Response(status=302, headers={"Location": "/"})
            self.set_token_cookie(resp)
            return resp
        raise web.HTTPFound(f"/?pair_error={res}")

    async def h_pair_post(self, req):
        body = await req.json()
        res = self.check_code(req, body.get("code"))
        if res != "ok":
            return web.json_response({"ok": False, "error": res}, status=403)
        resp = web.json_response({"ok": True})
        self.set_token_cookie(resp)
        return resp

    async def h_info(self, req):
        self.require_auth(req)
        return web.json_response(self.info(self.is_local(req)))

    async def h_qr(self, req):
        if not self.is_local(req):
            self.require_auth(req)
        kind = req.query.get("kind", "pair")
        data = self.urls()[1] if kind == "pair" else self.urls()[0]
        svg = qr_svg(data)
        if svg is None:
            raise web.HTTPNotFound()
        return web.Response(body=svg, content_type="image/svg+xml", headers={"Cache-Control": "no-store"})

    async def h_apps(self, req):
        self.require_auth(req)
        return web.json_response(self.state.apps)

    def _clean_app(self, body, base=None):
        a = dict(base or {})
        for k in ("name", "url", "label", "c1", "c2", "fg", "tagline", "ua", "back", "icon"):
            if k in body:
                a[k] = str(body[k])[:500]
        if not a.get("name"):
            raise web.HTTPBadRequest(text="name required")
        if a.get("type") != "system":
            url = a.get("url", "").strip()
            if not re.match(r"^https?://", url):
                url = "https://" + url
            a["url"] = url
        a.setdefault("label", a["name"])
        a.setdefault("c1", "#3a3a46")
        a.setdefault("c2", "#101016")
        a.setdefault("fg", "#ffffff")
        a.setdefault("ua", "default")
        a.setdefault("back", "smart")
        a.setdefault("tagline", "")
        return a

    async def h_app_add(self, req):
        self.require_auth(req)
        a = self._clean_app(await req.json())
        a["id"] = "app-" + uuid.uuid4().hex[:8]
        sys_idx = next((i for i, x in enumerate(self.state.apps) if x.get("type") == "system"), len(self.state.apps))
        self.state.apps.insert(sys_idx, a)
        self.state.save()
        await self.broadcast({"t": "apps", "apps": self.state.apps})
        return web.json_response(a)

    async def h_app_edit(self, req):
        self.require_auth(req)
        app = self.state.app(req.match_info["id"])
        if not app:
            raise web.HTTPNotFound()
        new = self._clean_app(await req.json(), app)
        app.clear()
        app.update(new)
        self.state.save()
        await self.broadcast({"t": "apps", "apps": self.state.apps})
        return web.json_response(app)

    async def h_app_delete(self, req):
        self.require_auth(req)
        app = self.state.app(req.match_info["id"])
        if not app or app.get("type") == "system":
            raise web.HTTPBadRequest()
        self.state.apps.remove(app)
        self.state.save()
        await self.broadcast({"t": "apps", "apps": self.state.apps})
        return web.json_response({"ok": True})

    async def h_app_order(self, req):
        self.require_auth(req)
        ids = (await req.json()).get("ids", [])
        by_id = {a["id"]: a for a in self.state.apps}
        ordered = [by_id.pop(i) for i in ids if i in by_id]
        self.state.apps = ordered + list(by_id.values())
        self.state.save()
        await self.broadcast({"t": "apps", "apps": self.state.apps})
        return web.json_response({"ok": True})

    async def h_apps_reset(self, req):
        self.require_auth(req)
        self.state.apps = json.loads((HOME / "server" / "default-apps.json").read_text())
        self.state.save()
        await self.broadcast({"t": "apps", "apps": self.state.apps})
        return web.json_response(self.state.apps)

    async def h_launch(self, req):
        self.require_auth(req)
        body = await req.json()
        if body.get("url"):
            app = self.state.app("browser") or {"id": "browser", "ua": "default", "back": "smart"}
            tmp = dict(app, id="url", url=self._clean_app({"name": "x", "url": body["url"]})["url"])
            if self.browser.ok:
                await self.browser.launch(tmp)
                await self.broadcast_state()
        else:
            await self.launch(body.get("id"))
        return web.json_response({"ok": True})

    async def h_settings(self, req):
        self.require_auth(req)
        if req.method == "POST":
            body = await req.json()
            s = self.state.settings
            if "device_name" in body:
                name = str(body["device_name"]).strip()[:40] or "NovaTV"
                s["device_name"] = name
                host = re.sub(r"[^a-z0-9-]", "", name.lower().replace(" ", "-")).strip("-")[:30] or "novatv"
                await arun(HELPER + ["hostname", host])
            if "screensaver_minutes" in body:
                s["screensaver_minutes"] = max(0, min(60, int(body["screensaver_minutes"])))
            if "keep_background" in body:
                s["keep_background"] = max(0, min(3, int(body["keep_background"])))
            if body.get("screensaver_style") in ("gradient", "black"):
                s["screensaver_style"] = body["screensaver_style"]
            if "setup_resume" in body:
                s["setup_resume"] = str(body["setup_resume"])[:20]
            restart = False
            if body.get("keyboard") in KB_LAYOUTS and body["keyboard"] != s["keyboard"]:
                s["keyboard"] = body["keyboard"]
                await arun(HELPER + ["keyboard", s["keyboard"]])
                restart = True
            self.state.save()
            await self.broadcast({"t": "settings", "settings": self.state.public_settings()})
            if restart:
                self.restart_ui_soon()
                return web.json_response(dict(self.state.public_settings(), restart=True))
        return web.json_response(self.state.public_settings())

    def restart_ui_soon(self, delay=1.5):
        if not DRY_RUN:
            asyncio.get_running_loop().call_later(delay, lambda: run(HELPER + ["restart-ui"]))

    async def h_repair(self, req):
        """Forget all paired phones and create a new pairing code."""
        self.require_auth(req)
        self.state.settings["pair_code"] = f"{secrets.randbelow(10**6):06d}"
        self.state.settings["token"] = secrets.token_urlsafe(32)
        self.state.save()
        for ws, role in list(self.clients.items()):
            if role == "remote":
                await ws.close()
        await self.broadcast({"t": "paircode"}, role="tv")
        resp = web.json_response({"ok": True})
        if not self.is_local(req):
            self.set_token_cookie(resp)  # keep the phone that asked paired
        return resp

    async def h_system(self, req):
        self.require_auth(req)
        action = req.match_info["action"]
        if action not in ("reboot", "poweroff", "restart-ui"):
            raise web.HTTPBadRequest()
        await self.toast({"reboot": "Restarting…", "poweroff": "Shutting down…",
                          "restart-ui": "Restarting the interface…"}[action])
        asyncio.get_running_loop().call_later(1.5, lambda: run(HELPER + [action]))
        return web.json_response({"ok": True})

    async def h_volume(self, req):
        self.require_auth(req)
        if req.method == "POST":
            body = await req.json()
            if "level" in body:
                return web.json_response(await self.audio.change_volume("set", body["level"]))
            if body.get("action") in ("volup", "voldown", "mute"):
                return web.json_response(await self.audio.change_volume(body["action"]))
        return web.json_response(await self.audio.read_volume())

    # ---- TV control (HDMI-CEC)
    async def h_cec(self, req):
        self.require_auth(req)
        s = self.state.settings
        if req.method == "POST":
            body = await req.json()
            changed = False
            for k in ("cec_enabled", "cec_autoswitch"):
                if k in body:
                    s[k] = bool(body[k])
                    changed = True
            if changed:
                self.state.save()
                await self.broadcast({"t": "settings", "settings": self.state.public_settings()})
                await arun(HELPER + ["cec", "restart"])
            if body.get("tv") in ("on", "off", "switch"):
                await arun(HELPER + ["cec", body["tv"]])
                await self.toast({"on": "Turning the TV on", "off": "Turning the TV off",
                                  "switch": "Switching the TV to NovaTV"}[body["tv"]])
        status = {"enabled": s["cec_enabled"], "connected": False}
        if DRY_RUN:
            status = {"enabled": s["cec_enabled"], "connected": s["cec_enabled"], "tv": "Samsung", "port": "HDMI 1"}
        else:
            try:
                status = json.loads(Path("/run/novatv-cec.json").read_text())
            except (OSError, json.JSONDecodeError):
                pass
        return web.json_response({**status, "enabled": s["cec_enabled"], "autoswitch": s["cec_autoswitch"]})

    # ---- display resolution
    def mode_label(self, w, h, r=None):
        name = {2160: "4K", 1440: "1440p", 1080: "1080p", 720: "720p", 576: "576p", 480: "480p"}.get(h, f"{w}×{h}")
        if w == 4096:
            name = "4K DCI"
        return f"{name} · {round(r)} Hz" if r is not None else name

    async def display_list(self):
        if DRY_RUN:
            modes = [(3840, 2160, 60.0), (3840, 2160, 59.94), (3840, 2160, 50.0), (3840, 2160, 30.0), (3840, 2160, 25.0),
                     (3840, 2160, 24.0), (2560, 1440, 60.0), (1920, 1080, 60.0), (1920, 1080, 50.0), (1920, 1080, 30.0),
                     (1920, 1080, 24.0), (1280, 720, 60.0), (1280, 720, 50.0)]
            cur = getattr(self, "_dry_display", "1920x1080@60.000")
            raw = {"name": "HDMI-A-1", "scale": 1, "modes": [{"w": w, "h": h, "r": r, "current": f"{w}x{h}@{r:.3f}" == cur}
                                                             for w, h, r in modes]}
        else:
            rc, out = await arun([str(HOME / "bin" / "novatv-display"), "list"], 20)
            try:
                raw = json.loads(out or "{}")
            except json.JSONDecodeError:
                raw = {}
        best = {}
        for m in raw.get("modes", []):
            if m["h"] < 720 or m["r"] > 61:
                continue
            key = (m["w"], m["h"], round(m["r"]))
            # keep one entry per resolution + rounded rate (60 Hz beats 59.94 Hz)
            if key not in best or abs(m["r"] - round(m["r"])) < abs(best[key]["r"] - round(best[key]["r"])) or m.get("current"):
                best[key] = dict(m, current=m.get("current") or best.get(key, {}).get("current", False))
        modes = sorted(best.values(), key=lambda m: (m["w"] * m["h"], m["r"]), reverse=True)
        items = [{"id": f"{m['w']}x{m['h']}@{m['r']:.3f}", "label": self.mode_label(m["w"], m["h"], m["r"]),
                  "w": m["w"], "h": m["h"], "r": round(m["r"], 3), "current": bool(m.get("current"))} for m in modes]
        top = items[0]["label"] if items else None
        cur = next((i for i in items if i["current"]), None)
        return {"output": raw.get("name"), "modes": items, "best": top,
                "current": cur["label"] if cur else None, "current_id": cur["id"] if cur else None,
                "setting": self.state.settings.get("display", "1920x1080@60"),
                "pending": getattr(self, "_display_pending", None) and self._display_pending["label"]}

    async def display_apply(self, mode):
        if DRY_RUN:
            self._dry_display = mode if mode != "auto" else "3840x2160@60.000"
            return True
        rc, _ = await arun([str(HOME / "bin" / "novatv-display"), "set", mode], 20)
        return rc == 0

    async def h_display(self, req):
        self.require_auth(req)
        if req.method == "GET":
            return web.json_response(await self.display_list())
        mode = str((await req.json()).get("mode", ""))
        if mode != "auto" and not re.fullmatch(r"\d{3,4}x\d{3,4}@[\d.]+", mode):
            raise web.HTTPBadRequest()
        info = await self.display_list()
        prev = info["current_id"] or self.state.settings.get("display", "1920x1080@60")
        label = info["best"] if mode == "auto" else next((m["label"] for m in info["modes"] if m["id"] == mode), mode)
        if not await self.display_apply(mode):
            return web.json_response({"ok": False, "error": "The TV doesn't accept this mode"}, status=400)
        # keep it only if somebody confirms: a TV that can't show the mode stays black otherwise
        if getattr(self, "_display_task", None):
            self._display_task.cancel()
        self._display_pending = {"mode": mode, "prev": prev, "label": f"Automatic ({label})" if mode == "auto" else label}

        async def revert_later():
            await asyncio.sleep(15)
            await self.display_confirm(False)
        self._display_task = asyncio.create_task(revert_later())
        await self.broadcast({"t": "display_confirm", "label": self._display_pending["label"], "seconds": 15})
        return web.json_response({"ok": True, "label": self._display_pending["label"], "seconds": 15})

    async def display_confirm(self, keep):
        p = getattr(self, "_display_pending", None)
        if not p:
            return
        self._display_pending = None
        task = getattr(self, "_display_task", None)
        if task and task is not asyncio.current_task():
            task.cancel()
        if keep:
            self.state.settings["display"] = p["mode"]
            self.state.save()
            await arun(HELPER + ["display-boot", p["mode"]])
            await self.toast(f"Resolution: {p['label']}")
        else:
            await self.display_apply(p["prev"])
            await self.toast("Resolution restored")
        await self.broadcast({"t": "display", **(await self.display_list())})

    async def h_display_confirm(self, req):
        self.require_auth(req)
        await self.display_confirm(bool((await req.json()).get("keep")))
        return web.json_response({"ok": True})

    # ---- audio, equalizer, bluetooth
    async def h_audio(self, req):
        self.require_auth(req)
        return web.json_response({**self.audio.public(), "bt": self.bt.public()})

    async def h_audio_output(self, req):
        self.require_auth(req)
        name = str((await req.json()).get("name", "auto"))
        if name != "auto" and not any(k["name"] == name for k in self.audio.sinks):
            raise web.HTTPBadRequest()
        self.state.settings["audio_output"] = name
        self.state.save()
        await self.audio.route()
        await self.broadcast({"t": "audio", **self.audio.public()})
        return web.json_response(self.audio.public())

    async def h_eq(self, req):
        self.require_auth(req)
        self.audio.set_eq(await req.json())
        return web.json_response({"eq": self.audio.eq})

    async def h_preset(self, req):
        self.require_auth(req)
        body = await req.json()
        action, name = body.get("action", "load"), str(body.get("name", ""))
        ok = {"load": self.audio.load_preset, "save": self.audio.save_preset,
              "delete": self.audio.delete_preset}.get(action, lambda n: False)(name)
        if not ok:
            return web.json_response({"ok": False}, status=400)
        self.state.save()
        await self.broadcast({"t": "audio", **self.audio.public()})
        if action == "save":
            await self.toast(f"Preset “{name}” saved")
        return web.json_response({"ok": True, **self.audio.public()})

    async def h_bt(self, req):
        self.require_auth(req)
        action = req.match_info["action"]
        body = await req.json() if req.can_read_body else {}
        mac = str(body.get("mac", "")).upper()
        if action == "scan":
            await self.bt.scan(bool(body.get("on", True)))
        elif action in ("pair", "connect", "disconnect", "forget"):
            if not re.fullmatch(r"([0-9A-F]{2}:){5}[0-9A-F]{2}", mac):
                raise web.HTTPBadRequest()
            asyncio.create_task(getattr(self.bt, action)(mac))
        else:
            raise web.HTTPNotFound()
        return web.json_response(self.bt.public())

    # ---- setup + network
    async def h_countries(self, req):
        return web.json_response([{"code": c, "name": n, "tz": tz} for c, (n, tz) in COUNTRIES.items()])

    async def h_setup_country(self, req):
        self.require_local(req)
        code = (await req.json()).get("code", "").upper()
        if code not in COUNTRIES:
            raise web.HTTPBadRequest()
        s = self.state.settings
        s["country"] = code
        await arun(HELPER + ["wifi-country", code], 30)
        await arun(HELPER + ["timezone", COUNTRIES[code][1]])
        layout = COUNTRY_KB.get(code, "us")
        restart = layout != s["keyboard"]
        if restart:
            # USB keyboards need the right layout before you type a Wi-Fi password
            s["keyboard"] = layout
            s["setup_resume"] = "network"
            await arun(HELPER + ["keyboard", layout])
        self.state.save()
        if restart and not DRY_RUN:
            self.restart_ui_soon()
        return web.json_response({"ok": True, "restart": restart and not DRY_RUN, "keyboard": layout})

    async def h_layouts(self, req):
        return web.json_response(KB_LAYOUTS)

    async def h_key(self, req):
        """Key press from a local source (HDMI-CEC bridge)."""
        if not self.is_local(req):
            raise web.HTTPForbidden()
        await self.remote_input({"t": "key", "k": (await req.json()).get("k")})
        return web.json_response({"ok": True})

    async def h_setup_done(self, req):
        self.require_local(req)
        self.state.settings["setup_done"] = True
        self.state.settings["setup_resume"] = ""
        self.state.save()
        await self.broadcast({"t": "settings", "settings": self.state.public_settings()})
        return web.json_response({"ok": True})

    async def h_net_status(self, req):
        self.require_local(req)
        return web.json_response(await self.net_status())

    async def net_status(self):
        rc, out = await arun(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"], 8)
        devices = []
        for line in (out or "").splitlines():
            parts = re.split(r"(?<!\\):", line)
            if len(parts) >= 4 and parts[1] in ("ethernet", "wifi"):
                devices.append({"device": parts[0], "type": parts[1], "state": parts[2],
                                "connection": parts[3].replace("\\:", ":")})
        self.ip = get_ip()
        eth = any(d["type"] == "ethernet" and d["state"] == "connected" for d in devices)
        wifi = next((d for d in devices if d["type"] == "wifi" and d["state"] == "connected"), None)
        if DRY_RUN:
            devices = [{"device": "wlan0", "type": "wifi", "state": "disconnected", "connection": ""}]
        return {"ip": self.ip, "ethernet": eth, "wifi": wifi["connection"] if wifi else None,
                "has_wifi": any(d["type"] == "wifi" for d in devices), "devices": devices}

    async def h_wifi_scan(self, req):
        self.require_local(req)
        if DRY_RUN:
            await asyncio.sleep(0.8)
            return web.json_response([
                {"ssid": "Telenet-Home", "signal": 86, "secure": True, "active": False},
                {"ssid": "Proximus-5G", "signal": 64, "secure": True, "active": False},
                {"ssid": "Guest WiFi", "signal": 41, "secure": False, "active": False},
                {"ssid": "Neighbours", "signal": 22, "secure": True, "active": False}])
        await arun(["nmcli", "radio", "wifi", "on"], 5)
        rc, out = await arun(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi",
                              "list", "--rescan", "yes"], 25)
        nets = {}
        for line in (out or "").splitlines():
            parts = re.split(r"(?<!\\):", line)
            if len(parts) < 4:
                continue
            ssid = parts[1].replace("\\:", ":")
            if not ssid:
                continue
            sig = int(parts[2] or 0)
            if ssid not in nets or nets[ssid]["signal"] < sig:
                nets[ssid] = {"ssid": ssid, "signal": sig, "secure": parts[3] not in ("", "--"),
                              "active": parts[0] == "*"}
        return web.json_response(sorted(nets.values(), key=lambda n: (-n["active"], -n["signal"])))

    async def h_wifi_connect(self, req):
        self.require_local(req)
        body = await req.json()
        ssid = str(body.get("ssid", ""))[:64]
        pw = str(body.get("password", ""))[:128]
        hidden = bool(body.get("hidden"))
        if not ssid:
            raise web.HTTPBadRequest()
        if DRY_RUN:
            await asyncio.sleep(1.5)
            ok = pw != "wrong"
            return web.json_response({"ok": ok, "ip": "192.168.1.42" if ok else None,
                                      "error": None if ok else "Incorrect password"})
        await arun(["nmcli", "connection", "delete", "id", ssid], 10)  # forget stale profile
        cmd = ["nmcli", "--wait", "40", "device", "wifi", "connect", ssid]
        if pw:
            cmd += ["password", pw]
        if hidden:
            cmd += ["hidden", "yes"]
        rc, out = await arun(cmd, 50)
        if rc != 0:
            await arun(["nmcli", "connection", "delete", "id", ssid], 10)
            return web.json_response({"ok": False, "error": "Could not join the network. Check the password."})
        for _ in range(20):  # wait for DHCP
            self.ip = get_ip()
            if self.ip:
                break
            await asyncio.sleep(0.5)
        await self.broadcast_state()
        return web.json_response({"ok": True, "ip": self.ip})

    # ---- websocket
    async def h_ws(self, req):
        if not self.authorized(req):
            raise web.HTTPUnauthorized()
        role = "tv" if self.is_local(req) and req.query.get("role") == "tv" else "remote"
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(req)
        self.clients[ws] = role
        await self.send(ws, {"t": "hello", **self.info(role == "tv"), "apps": self.state.apps,
                             "audio": self.audio.public(), "bt": self.bt.public()})
        if role == "remote":
            await self.broadcast({"t": "remote_connected"}, role="tv")
            await self.broadcast_state()
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                    t = m.get("t")
                    if t == "launch":
                        asyncio.create_task(self.launch(m.get("id")))
                    elif t == "home":
                        await self.home()
                    elif t == "ping":
                        await self.send(ws, {"t": "pong"})
                    else:
                        await self.remote_input(m)
                except Exception:  # noqa: BLE001
                    log.exception("ws message")
        finally:
            self.clients.pop(ws, None)
            if role == "remote":
                await self.broadcast_state()
        return ws

    # ---- background tasks
    async def watch_network(self):
        while True:
            ip = get_ip()
            if ip != self.ip:
                log.info("IP address is now %s", ip)
                self.ip = ip
                await self.broadcast_state()
            await asyncio.sleep(4)

    async def on_startup(self, app):
        app["tasks"] = [asyncio.create_task(self.browser.run_forever()),
                        asyncio.create_task(self.watch_network())]
        asyncio.create_task(self.audio.start())
        asyncio.create_task(self.bt.start())

    def make_app(self):
        app = web.Application(client_max_size=2 * 1024 * 1024)
        r = app.router
        r.add_get("/", self.h_root)
        r.add_get("/tv/", self.h_tv)
        r.add_get("/tv", self.h_tv_redirect)
        r.add_get("/pair", self.h_pair_get)
        r.add_post("/api/pair", self.h_pair_post)
        r.add_get("/api/info", self.h_info)
        r.add_get("/api/qr.svg", self.h_qr)
        r.add_get("/api/apps", self.h_apps)
        r.add_post("/api/apps", self.h_app_add)
        r.add_post("/api/apps/order", self.h_app_order)
        r.add_post("/api/apps/reset", self.h_apps_reset)
        r.add_put("/api/apps/{id}", self.h_app_edit)
        r.add_delete("/api/apps/{id}", self.h_app_delete)
        r.add_post("/api/launch", self.h_launch)
        r.add_route("*", "/api/settings", self.h_settings)
        r.add_post("/api/repair", self.h_repair)
        r.add_post("/api/system/{action}", self.h_system)
        r.add_route("*", "/api/volume", self.h_volume)
        r.add_get("/api/audio", self.h_audio)
        r.add_route("*", "/api/display", self.h_display)
        r.add_route("*", "/api/cec", self.h_cec)
        r.add_post("/api/display/confirm", self.h_display_confirm)
        r.add_post("/api/audio/output", self.h_audio_output)
        r.add_post("/api/audio/eq", self.h_eq)
        r.add_post("/api/audio/preset", self.h_preset)
        r.add_post("/api/bt/{action}", self.h_bt)
        r.add_get("/api/countries", self.h_countries)
        r.add_get("/api/layouts", self.h_layouts)
        r.add_post("/api/key", self.h_key)
        r.add_post("/api/setup/country", self.h_setup_country)
        r.add_post("/api/setup/done", self.h_setup_done)
        r.add_get("/api/net/status", self.h_net_status)
        r.add_get("/api/wifi/scan", self.h_wifi_scan)
        r.add_post("/api/wifi/connect", self.h_wifi_connect)
        r.add_get("/ws", self.h_ws)
        r.add_static("/tv/", HOME / "web" / "tv")
        r.add_static("/remote/", HOME / "web" / "remote")
        r.add_static("/shared/", HOME / "web" / "shared")
        app.on_startup.append(self.on_startup)
        return app


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    srv = Server()
    web.run_app(srv.make_app(), host="0.0.0.0", port=PORT, access_log=None, print=None)


if __name__ == "__main__":
    main()
