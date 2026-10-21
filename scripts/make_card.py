"""Link preview card and favicon for the live page: grey layout on the left, its LTX-2.5 render on the right.

    python scripts/make_card.py            # examples/ -> web/public/card.png, favicon.png

Reads examples/ only. Needs Pillow and ffmpeg (or `pip install imageio-ffmpeg`). The SVG favicon
(web/public/favicon.svg) is hand-written; favicon.png is the same mark, for browsers without SVG icons.
"""

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
LAYOUT = ROOT / "examples" / "layout_plaza_dolly_in_first.png"
RENDER = ROOT / "examples" / "stage1_day_plaza_a40.mp4"  # the day look that keeps the sky (as the hero GIF)
PUBLIC = ROOT / "web" / "public"

# web/src/style.css
BG, LINE, TEXT, MUTED, ACCENT = "#1b1d21", "#33373e", "#e6e6e6", "#9aa0a6", "#f0b429"
W, H = 1200, 630  # the size X, Bluesky, LinkedIn and Reddit all crop well

TITLE = "Open Cinema Studio"
TAGLINE = "Block a shot with grey boxes. Get a cinematic clip that follows that exact camera."
FOOTER = "Open weights only  ·  LTX-2.5 + Layout-to-Render  ·  Comfy SDK"


def ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def font(size, bold=False):
    """Inter or DejaVu if installed, else Pillow's built-in font (same layout, plainer look)."""
    names = ["Inter-Bold.otf", "DejaVuSans-Bold.ttf"] if bold else ["Inter-Regular.otf", "DejaVuSans.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    for d in ["/usr/share/fonts/opentype/inter", "/usr/share/fonts/truetype/dejavu"]:
        for name in names:
            if (Path(d) / name).exists():
                return ImageFont.truetype(str(Path(d) / name), size)
    return ImageFont.load_default(size)


def render_frame(seconds):
    """One frame of the render clip, as an RGB image."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "frame.png"
        subprocess.run(
            [ffmpeg(), "-v", "error", "-ss", str(seconds), "-i", str(RENDER), "-frames:v", "1", str(out)],
            check=True,
        )
        return Image.open(out).convert("RGB")


def fit(img, w, h):
    """Scale and centre-crop to exactly w×h."""
    scale = max(w / img.width, h / img.height)
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    left, top = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def panel(card, img, box, label):
    x, y, w, h = box
    card.paste(fit(img, w, h), (x, y))
    d = ImageDraw.Draw(card)
    d.rectangle((x - 1, y - 1, x + w, y + h), outline=LINE, width=1)
    f = font(22, bold=True)
    tw = d.textlength(label, font=f)
    d.rounded_rectangle((x + 14, y + h - 50, x + 14 + tw + 24, y + h - 14), radius=6, fill=(20, 22, 26))
    d.text((x + 26, y + h - 32), label, font=f, fill=TEXT, anchor="lm")


def make_card(seconds):
    card = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(card)
    m, gap = 40, 24
    d.text((m, 34), TITLE, font=font(52, bold=True), fill=TEXT)
    d.text((m, 102), TAGLINE, font=font(25), fill=MUTED)
    pw = (W - 2 * m - gap) // 2
    ph = round(pw * 576 / 960)  # the layout's 5:3
    top = 160
    panel(card, Image.open(LAYOUT).convert("RGB"), (m, top, pw, ph), "Grey layout")
    panel(card, render_frame(seconds), (m + pw + gap, top, pw, ph), "LTX-2.5 render")
    # the arrow between them, in the app's accent colour
    cx, cy = m + pw + gap // 2, top + ph // 2
    d.ellipse((cx - 20, cy - 20, cx + 20, cy + 20), fill=ACCENT)
    d.polygon([(cx - 6, cy - 9), (cx + 9, cy), (cx - 6, cy + 9)], fill=BG)
    d.text((m, H - 62), FOOTER, font=font(22), fill=MUTED, anchor="lm")
    d.text((W - m, H - 62), "#OpenSourceHiggsfield", font=font(22, bold=True), fill=ACCENT, anchor="rm")
    return card


def make_favicon(size):
    """favicon.svg drawn with Pillow: a grey box inside amber viewfinder corners."""
    s = 16  # draw at 64×16 and scale down, for smooth edges
    img = Image.new("RGBA", (64 * s, 64 * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, 64 * s - 1, 64 * s - 1), radius=12 * s, fill=BG)
    d.rectangle((22 * s, 22 * s, 42 * s, 42 * s), fill=MUTED)
    # the four corners, as in favicon.svg: 14 units long, 5 thick, 10 from the edge
    for x, y in [(10, 10), (40, 10), (10, 49), (40, 49)]:
        d.rectangle((x * s, y * s, (x + 14) * s, (y + 5) * s), fill=ACCENT)
    for x, y in [(10, 10), (49, 10), (10, 40), (49, 40)]:
        d.rectangle((x * s, y * s, (x + 5) * s, (y + 14) * s), fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", default=str(PUBLIC), help="output folder (default web/public/)")
    ap.add_argument("--at", type=float, default=0.0, help="render frame time in seconds (0 matches the layout)")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    make_card(args.at).save(out / "card.png", optimize=True)
    make_favicon(48).save(out / "favicon.png", optimize=True)
    print(f"wrote {out / 'card.png'}, favicon.png")


if __name__ == "__main__":
    main()
