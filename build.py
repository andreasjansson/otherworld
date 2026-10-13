"""Build the Otherworld site from bank.json and the effect sources (Python 3, stdlib only).

    python3 build.py

Writes site/index.html (the GitHub Pages page) from site/page.html, with each effect's
name, knobs and default knob positions read from its .spn header, and copies the sources
the page loads into site/fx/. Also writes build/preview.html, the same page without the
document wrapper, for previewing as a Claude.ai artifact.
"""
import base64
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def header(src, key):
    m = re.search(rf"^;\s*@{key}\s+(.*)$", src, re.M)
    return m.group(1).strip() if m else ""


def main():
    bank = json.loads((ROOT / "bank.json").read_text())
    effects = []
    for slot, entry in enumerate(bank["slots"], 1):
        src = (ROOT / "effects" / f"{entry['id']}.spn").read_text()
        name = header(src, "name")
        render = header(src, "render")
        effects.append({
            "id": entry["id"],
            "name": re.sub(r"_clk$", "", name),
            "clk": name.endswith("_clk"),
            "cat": entry["category"],
            "slot": slot,
            "knobs": [p.strip() for p in header(src, "pots").split("|")][:3],
            "pots": [float(v) for v in render.replace(" ", "").split(",")] if render else [0.5, 0.5, 0.5],
            **({"rate": entry.get("clock", "x2")} if name.endswith("_clk") else {}),   # the Pam's default
        })
        (ROOT / "site/fx").mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / "effects" / f"{entry['id']}.spn", ROOT / "site/fx" / f"{entry['id']}.spn")
    import hashlib
    build = hashlib.sha1(b"".join((ROOT / "site" / f).read_bytes() for f in ("fv1.wasm", "fv1-worklet.js", "mpeg4-glitch.wasm", "glitch-video.js", "header-4d.mp4"))).hexdigest()[:10]
    data = {"build": build, "effects": effects, "categories": bank["categories"], "loops": bank["loops"],
            "defaultLoop": bank["default_loop"], "clock": bank["clock_seconds"], "firmware": bank["firmware"]}
    page = (ROOT / "site/page.html").read_text().replace("/*__DATA__*/{}", json.dumps(data, separators=(",", ":")))
    # the header's poster (its first frame) inline, so it paints with the page instead of queueing
    # behind the video, the wasm and the loops
    poster = base64.b64encode((ROOT / "site/header-4d.webp").read_bytes()).decode()
    page = page.replace("url(header-4d.webp)", f"url(data:image/webp;base64,{poster})")
    head, body = page.split("<!--BODY-->", 1)
    (ROOT / "site/index.html").write_text(
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + head + "</head>\n<body>\n" + body + "</body>\n</html>\n")
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build/preview.html").write_text(head + body)
    print(f"wrote site/index.html and build/preview.html: {len(effects)} effects")


if __name__ == "__main__":
    main()
