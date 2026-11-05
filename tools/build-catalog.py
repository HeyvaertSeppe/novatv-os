#!/usr/bin/env python3
"""Builds the app catalog shipped with NovaTV from tools/catalog-src.json.

- adds the tile banner (rootfs/opt/novatv/web/shared/logos/<id>.png) when one exists
- writes rootfs/opt/novatv/server/catalog.json (all apps, App Library)
- writes rootfs/opt/novatv/server/default-apps.json (Home Screen on a fresh install)
Usage: python3 tools/build-catalog.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "catalog-src.json"
LOGOS = ROOT / "rootfs" / "opt" / "novatv" / "web" / "shared" / "logos"
OUT = ROOT / "rootfs" / "opt" / "novatv" / "server"
DEFAULT_HOME = ["netflix", "prime", "youtube", "stremio"]
SYSTEM = [
    {"id": "library", "name": "Add Apps", "type": "system", "label": "Add Apps", "icon": "plus",
     "c1": "#4b4b57", "c2": "#1c1c22", "fg": "#ffffff", "tagline": "Choose more streaming services for your Home Screen"},
    {"id": "settings", "name": "Settings", "type": "system", "label": "Settings", "icon": "gear",
     "c1": "#8e8e98", "c2": "#3a3a42", "fg": "#ffffff", "tagline": "Network, sound, display, remote and more"},
]


def main():
    apps = []
    for a in json.loads(SRC.read_text()):
        app = {k: v for k, v in a.items() if k not in ("term", "cc", "seller")}
        app.setdefault("label", app["name"])
        app.setdefault("fg", "#ffffff")
        app.setdefault("ua", "default")
        app.setdefault("back", "smart")
        if "icon" not in app and (LOGOS / f"{app['id']}.png").exists():
            app["icon"] = f"/shared/logos/{app['id']}.png"
        apps.append(app)
    (OUT / "catalog.json").write_text(json.dumps(apps, indent=1, ensure_ascii=False))
    by_id = {a["id"]: a for a in apps}
    home = [by_id[i] for i in DEFAULT_HOME] + SYSTEM
    (OUT / "default-apps.json").write_text(json.dumps(home, indent=1, ensure_ascii=False))
    missing = [a["id"] for a in apps if not a.get("icon")]
    print(f"{len(apps)} apps in catalog, home: {DEFAULT_HOME}, without logo: {missing}")


if __name__ == "__main__":
    main()
