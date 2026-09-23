#!/usr/bin/env python3
"""Extract the WMP "Headspace" skin (.wmz) into web-ready PNGs.

WMP skins are zip files of 24-bit BMPs. Transparency is keyed by colour:
magenta (#FF00FF) is the universal "see-through" key, and some subviews add
their own clippingColor (red for the head, white for the screen backing).
We bake those keys into real alpha so the webview can just stack <img>s.

The *_map.bmp files are hit-test maps: each button in a buttongroup is a
flat colour. Those are copied without alpha so the frontend can sample them.

The skin art is Microsoft's, so it stays out of git: run this against your
own copy of Headspace.wmz.

    python3 tools/convert_skin.py [path/to/Headspace.wmz]
"""

import io
import sys
import zipfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "skin"
ICONS = ROOT / "src-tauri" / "icons"
DEFAULT_WMZ = Path.home() / "Downloads" / "Headspace.wmz"

MAGENTA = (255, 0, 255)

# Extra per-file clipping keys, from clippingColor= in headspace.wms.
EXTRA_KEYS = {
    "head": [(255, 0, 0)],
    "vid_bkgd": [(255, 255, 255)],
}


def keyed(im: Image.Image, keys) -> Image.Image:
    rgb = im.convert("RGB")
    out = rgb.convert("RGBA")
    px = out.load()
    w, h = out.size
    keys = set(keys)
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if (r, g, b) in keys:
                px[x, y] = (0, 0, 0, 0)
    return out


def main() -> None:
    wmz = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_WMZ
    if not wmz.exists():
        sys.exit(f"skin not found: {wmz}")
    OUT.mkdir(parents=True, exist_ok=True)

    count = 0
    with zipfile.ZipFile(wmz) as z:
        for name in z.namelist():
            if not name.lower().endswith(".bmp"):
                continue
            stem = Path(name).stem
            im = Image.open(io.BytesIO(z.read(name)))
            if stem.endswith("_map"):
                im = im.convert("RGB")
            else:
                im = keyed(im, [MAGENTA, *EXTRA_KEYS.get(stem, [])])
            # Lowercase on disk: the .wms mixes case freely and the web does not.
            im.save(OUT / f"{stem.lower()}.png")
            count += 1
    print(f"wrote {count} images to {OUT.relative_to(ROOT)}")
    write_icon()


def write_icon() -> None:
    """The head, centred on a 1024 square, for `tauri icon` to slice up."""
    head = Image.open(OUT / "head.png")
    scale = 900 / head.height
    head = head.resize((round(head.width * scale), 900), Image.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    canvas.alpha_composite(head, ((1024 - head.width) // 2, 62))
    ICONS.mkdir(parents=True, exist_ok=True)
    canvas.save(ICONS / "app-icon.png")


if __name__ == "__main__":
    main()
