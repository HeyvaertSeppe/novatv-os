"""NovaTV audio: outputs (HDMI / Bluetooth), volume, equalizer and Bluetooth pairing.

Sound path:  every app  ->  "NovaTV Equalizer" (PipeWire filter-chain sink, the default output)
                         ->  the real output (TV over HDMI, or a Bluetooth speaker).
Volume is applied to the real output, so a Bluetooth speaker's own volume follows
(PipeWire uses Bluetooth absolute volume when the speaker supports it).
"""
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess

log = logging.getLogger("novatv.audio")
DRY_RUN = os.environ.get("NOVATV_DRY_RUN") == "1"

EQ_SINK = "novatv_eq"
EQ_OUT = "novatv_eq.output"
BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
BAND_RANGE = (-12.0, 12.0)
ISO_RANGE = (-26.0, 6.0)      # like a DJ mixer isolator: full cut ("kill") to +6 dB

PRESETS = {  # 10 bands (31 Hz .. 16 kHz) in dB
    "Flat":        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "Bass Boost":  [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    "Movie":       [4, 3, 1, 0, -1, 0, 1, 2, 2, 1],
    "Dialogue":    [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1],
    "Music":       [3, 2, 0, -1, -1, 0, 1, 2, 3, 3],
    "Night Mode":  [-5, -4, -2, 0, 1, 2, 2, 1, -1, -2],
    "Loudness":    [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
    "Rock":        [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
    "Electronic":  [5, 4, 1, 0, -2, 0, 1, 2, 4, 5],
    "Treble Boost": [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
}


def default_eq():
    return {"enabled": True, "bands": [0.0] * 10, "low": 0.0, "mid": 0.0, "high": 0.0}


def clamp(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = 0.0
    return round(max(lo, min(hi, v)), 1)


def env():
    e = dict(os.environ)
    e.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    return e


async def sh(*cmd, timeout=15, inp=None):
    """Run a command, return (rc, stdout)."""
    if DRY_RUN:
        return 0, ""
    try:
        p = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE if inp else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env())
        out, err = await asyncio.wait_for(p.communicate(inp.encode() if inp else None), timeout)
        return p.returncode, out.decode(errors="replace")
    except Exception as e:  # noqa: BLE001
        log.warning("%s failed: %s", cmd[0], e)
        return 1, ""


# =========================================================================== audio

class Audio:
    def __init__(self, server):
        self.srv = server
        self.sinks = []            # real outputs: [{id, serial, name, description, bluetooth}]
        self.eq_id = None
        self.eq_out_id = None
        self.eq_serial = None
        self.active = None         # name of the real output in use
        self.volume = {"level": 50, "muted": False}
        self._eq_dirty = asyncio.Event()
        self._lock = asyncio.Lock()
        s = server.state.settings
        s.setdefault("eq", default_eq())
        s.setdefault("eq_preset", "Flat")
        s.setdefault("eq_presets", {})
        s.setdefault("audio_output", "auto")
        if DRY_RUN:
            self.sinks = [{"id": 46, "serial": 46, "name": "alsa_output.hdmi", "description": "TV (HDMI)", "bluetooth": False}]
            self.active = "alsa_output.hdmi"

    # ---- state for the UIs
    @property
    def eq(self):
        return self.srv.state.settings["eq"]

    def public(self):
        s = self.srv.state.settings
        return {
            "volume": self.volume,
            "outputs": [{"name": k["name"], "description": k["description"], "bluetooth": k["bluetooth"]} for k in self.sinks],
            "output_mode": s["audio_output"],
            "active": self.active,
            "active_name": self.output_label(),
            "active_bluetooth": self.active_is_bt(),
            "eq": self.eq,
            "eq_ready": self.eq_id is not None or DRY_RUN,
            "preset": s["eq_preset"],
            "presets": {"builtin": list(PRESETS), "user": sorted(s["eq_presets"])},
            "bands": BANDS,
        }

    def output_label(self):
        k = next((k for k in self.sinks if k["name"] == self.active), None)
        return k["description"] if k else "TV"

    def active_is_bt(self):
        k = next((k for k in self.sinks if k["name"] == self.active), None)
        return bool(k and k["bluetooth"])

    # ---- PipeWire graph
    async def scan(self):
        rc, out = await sh("pw-dump", timeout=10)
        if rc != 0 or not out.strip():
            return None
        try:
            objs = json.loads(out)
        except json.JSONDecodeError:
            return None
        nodes, links = {}, []
        for o in objs:
            if o.get("type") == "PipeWire:Interface:Node":
                nodes[o["id"]] = o.get("info", {}).get("props", {})
            elif o.get("type") == "PipeWire:Interface:Link":
                info = o.get("info", {})
                links.append((info.get("output-node-id"), info.get("input-node-id")))
        sinks = []
        self.eq_id = self.eq_out_id = self.eq_serial = None
        for nid, p in nodes.items():
            name = p.get("node.name", "")
            if name == EQ_SINK:
                self.eq_id, self.eq_serial = nid, p.get("object.serial", nid)
            elif name == EQ_OUT:
                self.eq_out_id = nid
            elif p.get("media.class") == "Audio/Sink":
                bt = p.get("device.api") == "bluez5" or name.startswith("bluez_")
                desc = p.get("node.description") or p.get("node.nick") or name
                if not bt and "hdmi" in name.lower():
                    desc = "TV (HDMI)"
                sinks.append({"id": nid, "serial": p.get("object.serial", nid), "name": name,
                              "description": desc, "bluetooth": bt})
        sinks.sort(key=lambda k: (not k["bluetooth"], "hdmi" not in k["name"].lower(), k["name"]))
        self.sinks = sinks
        return nodes, links

    def pick_output(self):
        mode = self.srv.state.settings["audio_output"]
        if mode != "auto" and any(k["name"] == mode for k in self.sinks):
            return mode
        bt = next((k for k in self.sinks if k["bluetooth"]), None)   # a connected speaker wins
        if bt:
            return bt["name"]
        return self.sinks[0]["name"] if self.sinks else None

    async def route(self, graph=None):
        """Point the equalizer at the right output and keep it the default sink."""
        async with self._lock:
            graph = graph or await self.scan()
            if not graph:
                return
            nodes, links = graph
            target = self.pick_output()
            changed = target != self.active
            sink = next((k for k in self.sinks if k["name"] == target), None)
            if self.eq_id is not None and sink:
                linked = {i for o, i in links if o == self.eq_out_id}
                if sink["id"] not in linked or changed:
                    await sh("pw-metadata", str(self.eq_out_id), "target.object", str(sink["serial"]))
                await sh("wpctl", "set-default", str(self.eq_id))
                # apps that play straight to a real output (bypassing the EQ) are moved back into it
                hw = {k["id"] for k in self.sinks}
                for o, i in links:
                    p = nodes.get(o, {})
                    if i in hw and o != self.eq_out_id and p.get("media.class") == "Stream/Output/Audio":
                        log.info("moving %s into the equalizer", p.get("node.name"))
                        await sh("pw-metadata", str(o), "target.object", str(self.eq_serial))
            elif sink:   # no equalizer available: plain default sink
                await sh("wpctl", "set-default", str(sink["id"]))
            self.active = target
            if changed:
                await self.read_volume()
                await self.srv.broadcast({"t": "audio", **self.public()})
                if target:
                    await self.srv.toast(f"Sound: {self.output_label()}")

    async def watch(self):
        await asyncio.sleep(3)
        while True:
            try:
                if not DRY_RUN:
                    await self.route()
                    if self.eq_id is not None and getattr(self, "_eq_applied_to", None) != self.eq_id:
                        await self.apply_eq()   # EQ node (re)appeared, e.g. PipeWire restarted
            except Exception:  # noqa: BLE001
                log.exception("audio watch")
            await asyncio.sleep(3)

    # ---- volume (on the real output)
    def _target_id(self):
        k = next((k for k in self.sinks if k["name"] == self.active), None)
        return str(k["id"]) if k else "@DEFAULT_AUDIO_SINK@"

    async def read_volume(self):
        if DRY_RUN:
            return self.volume
        rc, out = await sh("wpctl", "get-volume", self._target_id(), timeout=5)
        m = re.search(r"Volume:\s*([\d.]+)", out or "")
        if m:
            self.volume = {"level": round(float(m.group(1)) * 100), "muted": "MUTED" in out}
        return self.volume

    async def change_volume(self, action, level=None):
        tid = self._target_id()
        if action == "mute":
            await sh("wpctl", "set-mute", tid, "toggle")
            self.volume["muted"] = not self.volume["muted"]
        else:
            if action == "set":
                new = max(0, min(100, int(level)))
            else:
                new = max(0, min(100, self.volume["level"] + (5 if action == "volup" else -5)))
            await sh("wpctl", "set-volume", tid, f"{new / 100:.2f}")
            await sh("wpctl", "set-mute", tid, "0")
            self.volume = {"level": new, "muted": False}
        if not DRY_RUN:
            await self.read_volume()
        v = dict(self.volume, output=self.output_label(), bluetooth=self.active_is_bt())
        await self.srv.broadcast({"t": "volume", **v})
        await self.srv.browser.hud("volume", v)
        return v

    # ---- equalizer
    def set_eq(self, upd):
        eq = self.eq
        if "bands" in upd and isinstance(upd["bands"], list) and len(upd["bands"]) == 10:
            eq["bands"] = [clamp(v, *BAND_RANGE) for v in upd["bands"]]
        if "band" in upd and "value" in upd:
            i = int(upd["band"])
            if 0 <= i < 10:
                eq["bands"][i] = clamp(upd["value"], *BAND_RANGE)
        for k in ("low", "mid", "high"):
            if k in upd:
                eq[k] = clamp(upd[k], *ISO_RANGE)
        if "enabled" in upd:
            eq["enabled"] = bool(upd["enabled"])
        self.srv.state.settings["eq_preset"] = upd.get("preset_name", "Custom")
        self._eq_dirty.set()

    def load_preset(self, name):
        s = self.srv.state.settings
        if name in PRESETS:
            self.eq["bands"] = [float(v) for v in PRESETS[name]]
            self.eq["low"] = self.eq["mid"] = self.eq["high"] = 0.0
        elif name in s["eq_presets"]:
            p = s["eq_presets"][name]
            self.eq["bands"] = [clamp(v, *BAND_RANGE) for v in p["bands"]]
            for k in ("low", "mid", "high"):
                self.eq[k] = clamp(p.get(k, 0), *ISO_RANGE)
        else:
            return False
        self.eq["enabled"] = True
        s["eq_preset"] = name
        self._eq_dirty.set()
        return True

    def save_preset(self, name):
        name = str(name).strip()[:24]
        if not name or name in PRESETS:
            return False
        s = self.srv.state.settings
        s["eq_presets"][name] = {"bands": list(self.eq["bands"]), "low": self.eq["low"],
                                 "mid": self.eq["mid"], "high": self.eq["high"]}
        s["eq_preset"] = name
        return True

    def delete_preset(self, name):
        s = self.srv.state.settings
        if s["eq_presets"].pop(name, None) is None:
            return False
        if s["eq_preset"] == name:
            s["eq_preset"] = "Custom"
        return True

    def params(self):
        eq = self.eq
        on = eq["enabled"]
        bands = eq["bands"] if on else [0.0] * 10
        low, mid, high = (eq["low"], eq["mid"], eq["high"]) if on else (0.0, 0.0, 0.0)
        # automatic headroom so boosts don't clip
        boost = max([0.0] + bands) + max(0.0, low, mid, high) * 0.6
        pre = -min(12.0, boost * 0.8)
        p = [f"pre:Gain", round(pre, 2), "low:Gain", low, "mid:Gain", mid, "high:Gain", high]
        for i, g in enumerate(bands, 1):
            p += [f"b{i}:Gain", g]
        return p

    async def apply_eq(self):
        if self.eq_id is None:
            return
        p = self.params()
        body = " ".join(f'"{k}" {float(v):.2f}' if isinstance(v, (int, float)) else f'"{v}"'
                        for k, v in zip(p[::2], p[1::2]))
        await sh("pw-cli", "set-param", str(self.eq_id), "Props", f"{{ params = [ {body} ] }}")
        self._eq_applied_to = self.eq_id

    async def eq_loop(self):
        """Applies EQ changes at most ~25 times a second, saves them, tells every screen."""
        while True:
            await self._eq_dirty.wait()
            self._eq_dirty.clear()
            if not DRY_RUN:
                await self.apply_eq()
            self.srv.state.save()
            await self.srv.broadcast({"t": "eq", "eq": self.eq, "preset": self.srv.state.settings["eq_preset"]})
            await asyncio.sleep(0.04)

    async def start(self):
        if not DRY_RUN:
            await self.route()
            await self.read_volume()
            await self.apply_eq()
        asyncio.create_task(self.eq_loop())
        asyncio.create_task(self.watch())


# =========================================================================== bluetooth

class Bluetooth:
    """Pairs and connects Bluetooth speakers/headphones through bluetoothctl."""

    def __init__(self, server):
        self.srv = server
        self.agent = None
        self.scanning = False
        self.devices = {}          # mac -> {mac, name, paired, connected, trusted, icon, audio}
        self.busy = {}             # mac -> "pairing" | "connecting" | ...
        self.available = DRY_RUN or shutil.which("bluetoothctl") is not None
        if DRY_RUN:
            self.devices = {
                "AA:BB:CC:11:22:33": {"mac": "AA:BB:CC:11:22:33", "name": "JBL Flip 6", "paired": True, "connected": False, "trusted": True, "icon": "audio-card", "audio": True},
                "AA:BB:CC:44:55:66": {"mac": "AA:BB:CC:44:55:66", "name": "Sonos Roam", "paired": False, "connected": False, "trusted": False, "icon": "audio-card", "audio": True},
                "AA:BB:CC:77:88:99": {"mac": "AA:BB:CC:77:88:99", "name": "AirPods Pro", "paired": False, "connected": False, "trusted": False, "icon": "audio-headphones", "audio": True},
            }

    def public(self):
        devs = sorted(self.devices.values(), key=lambda d: (not d["connected"], not d["paired"], d["name"].lower()))
        return {"available": self.available, "scanning": self.scanning,
                "devices": [dict(d, busy=self.busy.get(d["mac"])) for d in devs if d["paired"] or d["audio"]]}

    async def changed(self):
        await self.srv.broadcast({"t": "bt", **self.public()})

    async def start(self):
        if DRY_RUN or not self.available:
            return
        await sh("rfkill", "unblock", "bluetooth")
        # a long-lived bluetoothctl acts as the pairing agent (speakers need no PIN)
        try:
            self.agent = await asyncio.create_subprocess_exec(
                "bluetoothctl", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT, env=env())
            for c in ("power on", "agent NoInputNoOutput", "default-agent", "pairable on"):
                await self._agent_cmd(c)
            asyncio.create_task(self._agent_reader())
        except Exception:  # noqa: BLE001
            log.exception("bluetoothctl agent")
        await self.refresh()
        last = self.srv.state.settings.get("bt_last")
        if last and last in self.devices and not self.devices[last]["connected"]:
            asyncio.create_task(self.connect(last, quiet=True))
        asyncio.create_task(self._poll())

    async def _agent_cmd(self, c):
        if self.agent and self.agent.stdin:
            self.agent.stdin.write((c + "\n").encode())
            await self.agent.stdin.drain()

    async def _agent_reader(self):
        while self.agent and not self.agent.stdout.at_eof():
            line = (await self.agent.stdout.readline()).decode(errors="replace")
            line = re.sub(r"\x1b\[[0-9;]*m|\r", "", line)
            if re.search(r"Confirm passkey|Authorize service|Request confirmation", line):
                await self._agent_cmd("yes")
            if "[NEW] Device" in line or "[DEL] Device" in line or "Connected:" in line or "Paired:" in line:
                asyncio.create_task(self.refresh())

    async def _poll(self):
        while True:
            await asyncio.sleep(10 if not self.scanning else 3)
            await self.refresh()

    async def refresh(self):
        if DRY_RUN:
            return
        rc, out = await sh("bluetoothctl", "devices", timeout=8)
        found = {}
        for m in re.finditer(r"Device ([0-9A-F:]{17}) (.+)", out or ""):
            found[m.group(1)] = m.group(2).strip()
        infos = await asyncio.gather(*(sh("bluetoothctl", "info", mac, timeout=8) for mac in found))
        devices = {}
        for (mac, name), (_, info) in zip(found.items(), infos):
            def flag(k):
                return re.search(rf"{k}:\s*yes", info or "") is not None
            icon = (re.search(r"Icon:\s*(\S+)", info or "") or [None, ""])[1]
            audio = icon.startswith("audio") or "0000110b" in (info or "").lower() or "Audio Sink" in (info or "")
            if re.fullmatch(r"([0-9A-F]{2}-){5}[0-9A-F]{2}", name):
                name = "Unknown device"
            devices[mac] = {"mac": mac, "name": name, "paired": flag("Paired"), "connected": flag("Connected"),
                            "trusted": flag("Trusted"), "icon": icon, "audio": audio and name != "Unknown device"}
        if devices != self.devices:
            self.devices = devices
            await self.changed()

    async def scan(self, on=True):
        if DRY_RUN:
            self.scanning = on
            await self.changed()
            return
        if on and not self.scanning:
            self.scanning = True
            await self._agent_cmd("scan on")
            await self.changed()

            async def stop_later():
                await asyncio.sleep(30)
                await self.scan(False)
            asyncio.create_task(stop_later())
        elif not on and self.scanning:
            self.scanning = False
            await self._agent_cmd("scan off")
            await self.changed()

    async def _step(self, mac, label, *cmd, ok=r"successful|already|Changing .* succeeded", timeout=30):
        self.busy[mac] = label
        await self.changed()
        rc, out = await sh("bluetoothctl", *cmd, mac, timeout=timeout)
        return rc == 0 or re.search(ok, out or "", re.I) is not None

    async def pair(self, mac):
        """Pair, trust and connect a speaker in one go."""
        if mac not in self.devices:
            return False
        try:
            if DRY_RUN:
                self.busy[mac] = "pairing"; await self.changed(); await asyncio.sleep(1.5)
                d = self.devices[mac]; d.update(paired=True, trusted=True, connected=True)
                self.srv.state.settings["bt_last"] = mac
                return True
            if self.scanning:
                await self.scan(False)
            if not await self._step(mac, "pairing", "pair", timeout=40):
                await self.srv.toast("Pairing failed. Put the speaker in pairing mode and try again.")
                return False
            await self._step(mac, "pairing", "trust")
            return await self.connect(mac)
        finally:
            self.busy.pop(mac, None)
            await self.refresh()
            await self.changed()

    async def connect(self, mac, quiet=False):
        try:
            if DRY_RUN:
                self.devices[mac]["connected"] = True
                self.srv.state.settings["bt_last"] = mac
                return True
            await self._step(mac, "trusting", "trust")
            ok = await self._step(mac, "connecting", "connect", timeout=30)
            if ok:
                self.srv.state.settings["bt_last"] = mac
                self.srv.state.save()
                # make the speaker the sound output straight away
                self.srv.state.settings["audio_output"] = "auto"
                for _ in range(10):
                    await asyncio.sleep(1)
                    await self.srv.audio.route()
                    if self.srv.audio.active_is_bt():
                        break
            elif not quiet:
                name = self.devices.get(mac, {}).get("name", "the speaker")
                await self.srv.toast(f"Couldn't connect to {name}. Is it switched on?")
            return ok
        finally:
            self.busy.pop(mac, None)
            await self.refresh()
            await self.changed()

    async def disconnect(self, mac):
        if DRY_RUN:
            self.devices[mac]["connected"] = False
        else:
            await self._step(mac, "disconnecting", "disconnect")
        self.busy.pop(mac, None)
        await self.refresh()
        await self.changed()
        await self.srv.audio.route()

    async def forget(self, mac):
        if DRY_RUN:
            self.devices[mac].update(paired=False, connected=False, trusted=False)
        else:
            await self._step(mac, "removing", "remove")
        if self.srv.state.settings.get("bt_last") == mac:
            self.srv.state.settings["bt_last"] = None
        self.busy.pop(mac, None)
        await self.refresh()
        await self.changed()
        await self.srv.audio.route()
