"""One layout, three looks: the plaza dolly-in rendered with three prompts, plus a 2×2 comparison
(layout + the three renders) as an MP4 and a README GIF. This is the VFX evidence shot: same
blocking and camera, only the prompt changes. Needs a GPU target (see README "Render").

    COMFY_BASE_URL=http://127.0.0.1:8189 python scripts/three_looks.py      # ~3.5 min a look on an A40
    python scripts/three_looks.py --dry-run                                  # print the commands only
    python scripts/three_looks.py --grid-only                                # rebuild the grid from existing renders

Writes examples/look_<name>_plaza.png, examples/stage1_<name>_plaza_a40.mp4,
examples/three_looks_plaza.mp4 and docs/media/three_looks.gif.
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / "examples"
LAYOUT = EX / "layout_plaza_dolly_in.mp4"
DEPTH = EX / "layout_plaza_dolly_in_depth.png"

# The plaza prompts from web/src/prompts.js (Render panel > Prompt ideas), so the app can reproduce them.
LOOKS = {
    "day": "A sunny stone plaza with a glass office tower, an iron lamp post, stacked wooden crates and a white market kiosk, slow push-in.",
    "night": "A rainy night plaza lit by a single street lamp, wet cobblestones reflecting neon from a closed kiosk, crates stacked in the shadows, slow push-in.",
    "snow": "A snowy winter square at dusk with a brick clock tower, a glowing lamp post and a wooden market stall dusted with snow, gentle camera push.",
}


def ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def paths(name):
    return EX / f"look_{name}_plaza.png", EX / f"stage1_{name}_plaza_a40.mp4"


def render_commands(seed=42):
    """The look-still and render command for each look, in order."""
    cmds = []
    for name, prompt in LOOKS.items():
        look, out = paths(name)
        cmds.append([sys.executable, "-m", "server.look", str(DEPTH), prompt, "-o", str(look), "--seed", str(seed)])
        cmds.append([sys.executable, "-m", "server.render", str(LAYOUT), str(look), prompt, "-o", str(out), "--seed", str(seed)])
    return cmds


def grid_filter(width, fps=None, gif=False):
    """2×2: layout top left, then the looks in LOOKS order; optional GIF palette."""
    rate = f"fps={fps}," if fps else ""
    f = "".join(f"[{i}:v]{rate}scale={width}:-2:flags=lanczos,setsar=1[v{i}];" for i in range(4))
    f += "[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0"
    if gif:
        f += ",split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    return f


def build_grid(width=480):
    inputs = [LAYOUT] + [paths(n)[1] for n in LOOKS]
    missing = [str(p) for p in inputs if not p.exists()]
    if missing:
        sys.exit(f"missing renders: {', '.join(missing)}")
    args = [a for p in inputs for a in ("-i", str(p))]
    mp4 = EX / "three_looks_plaza.mp4"
    gif = ROOT / "docs" / "media" / "three_looks.gif"
    subprocess.run([ffmpeg(), "-v", "error", "-y", *args, "-filter_complex", grid_filter(width),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-an", str(mp4)], check=True)
    subprocess.run([ffmpeg(), "-v", "error", "-y", *args, "-filter_complex", grid_filter(320, fps=12, gif=True),
                    "-loop", "0", str(gif)], check=True)
    print(f"wrote {mp4} and {gif} ({gif.stat().st_size / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--dry-run", action="store_true", help="print the commands, run nothing")
    ap.add_argument("--grid-only", action="store_true", help="skip rendering; build the grid from existing renders")
    args = ap.parse_args()
    if not args.grid_only:
        for cmd in render_commands(args.seed):
            print("+", " ".join(cmd[1:]), flush=True)
            if not args.dry_run:
                subprocess.run(cmd, check=True, cwd=ROOT)
    if not args.dry_run:
        build_grid()


if __name__ == "__main__":
    main()
