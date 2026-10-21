"""README hero GIF: the grey layout clip and its LTX-2.5 render, side by side, looping.

    python scripts/make_hero.py            # examples/ -> docs/media/hero.gif

Needs ffmpeg (or `pip install imageio-ffmpeg`).
"""

import argparse
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAYOUT = ROOT / "examples" / "layout_plaza_dolly_in.mp4"
RENDER = ROOT / "examples" / "stage1_genlook_plaza_a40.mp4"


def ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def hero_filter(width, fps):
    """Scale both clips to `width` each, put them side by side, and make a GIF palette from both."""
    return (
        f"[0:v]fps={fps},scale={width}:-2:flags=lanczos,setsar=1[a];"
        f"[1:v]fps={fps},scale={width}:-2:flags=lanczos,setsar=1[b];"
        "[a][b]hstack=inputs=2,split[s0][s1];"
        "[s0]palettegen=max_colors=192:stats_mode=diff[p];"
        "[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", default=str(ROOT / "docs" / "media" / "hero.gif"))
    ap.add_argument("--width", type=int, default=480, help="width of each half (default 480)")
    ap.add_argument("--fps", type=int, default=12)
    args = ap.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg(), "-v", "error", "-y", "-i", str(LAYOUT), "-i", str(RENDER),
                    "-filter_complex", hero_filter(args.width, args.fps), "-loop", "0", str(out)], check=True)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
