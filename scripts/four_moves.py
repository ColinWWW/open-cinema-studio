"""Four places, four camera moves: the Blocks layout shot with an orbit, a crane up, a truck and a dolly in,
each rendered as a different place, plus a 2×2 grid (each render with its grey layout inset) as an MP4 and a
README GIF. The other half of the VFX evidence next to three_looks.py: here the camera and the place change.
Needs a GPU target (see README "Render").

    COMFY_BASE_URL=http://127.0.0.1:8189 python scripts/four_moves.py   # ~4 min a clip on an A40
    python scripts/four_moves.py --dry-run                               # print the commands only
    python scripts/four_moves.py --grid-only                             # rebuild the grid from existing renders

Writes examples/layout_blocks_<move>.mp4 (+ _depth.png, _first.png), examples/look_<place>_blocks_a40.png,
examples/stage1_<place>_<move>_a40.mp4, examples/four_moves.mp4 and docs/media/four_moves.gif.
Only the camera moves: the blocked stand-ins stay put (the editor keys the camera, not the objects).
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / "examples"
FRAMES = 97  # 4 s

# move -> (place, prompt, seed). The prompts are web/src/prompts.js's Blocks ideas with the camera phrase
# changed to the move. Seeds were picked on an A40 (Oct 21) by checking each look still against its depth map.
CLIPS = {
    "orbit": ("harbour", "Shipping containers on a foggy harbour quay at dawn, cranes in the distance, a dock worker "
                         "standing by the crates, slow orbit around the containers.", 42),
    "crane_up": ("desert", "Brutalist concrete buildings in a desert at noon, harsh shadows, a lone traveller walking "
                           "between them, camera rising slowly.", 2024),
    "truck": ("tokyo", "An empty Tokyo parking lot at night under a dark sky, two concrete blocks standing apart with "
                       "glowing neon signs, cardboard boxes on the wet asphalt, a lone figure in a raincoat, slow "
                       "sideways tracking shot.", 2024),
    "dolly_in": ("warehouse", "An abandoned warehouse with dusty sunbeams through broken windows, wooden pallets on "
                              "the floor, a woman in a red coat, slow push-in.", 42),
}
LABELS = {"orbit": "Orbit", "crane_up": "Crane up", "truck": "Truck", "dolly_in": "Dolly in"}


def ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def paths(move):
    place = CLIPS[move][0]
    layout = EX / f"layout_blocks_{move}.mp4"
    return layout, layout.with_name(layout.stem + "_depth.png"), EX / f"look_{place}_blocks_a40.png", \
        EX / f"stage1_{place}_{move}_a40.mp4"


def render_commands():
    """For each move: draw the layout (and its depth), make the look still, render the clip."""
    cmds = []
    py = sys.executable
    for move, (_, prompt, seed) in CLIPS.items():
        layout, depth, look, out = paths(move)
        cmds.append([py, "scripts/make_test_layout.py", "--scene", "blocks", "--move", move, "--frames", str(FRAMES),
                     "-o", str(layout)])
        cmds.append([py, "-m", "server.look", str(depth), prompt, "-o", str(look), "--seed", str(seed)])
        cmds.append([py, "-m", "server.render", str(layout), str(look), prompt, "-o", str(out), "--seed", str(seed)])
    return cmds


def font_option():
    """drawtext's fontfile= for a TTF found the way scripts/demo/assemble.py finds one ('' if none: on Windows,
    ffmpeg's drawtext crashes without a fontfile, so then the labels are left out instead)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("assemble", ROOT / "scripts" / "demo" / "assemble.py")
    demo = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("assemble", demo)  # its @dataclass looks the module up there
    spec.loader.exec_module(demo)
    font = demo.find_font(bold=True)
    return f"fontfile='{demo.esc(font)}':" if font else None


def grid_filter(width, fps=None, gif=False, font=""):
    """2×2 of the renders in CLIPS order, each with its layout inset bottom-left and the move named.
    `font` is a drawtext fontfile option (see font_option); None leaves the labels out."""
    rate = f"fps={fps}," if fps else ""
    inset = width // 3
    f = ""
    for i, move in enumerate(CLIPS):
        r, lay = 2 * i, 2 * i + 1
        label = "" if font is None else (
            f",drawtext={font}text='{LABELS[move]}':x=w-tw-12:y=10:fontsize={max(14, width // 24)}:fontcolor=white:"
            "box=1:boxcolor=black@0.55:boxborderw=6")
        f += (f"[{r}:v]{rate}scale={width}:-2:flags=lanczos,setsar=1[r{i}];"
              f"[{lay}:v]{rate}scale={inset}:-2:flags=lanczos,setsar=1,pad=iw+4:ih+4:2:2:color=white[l{i}];"
              f"[r{i}][l{i}]overlay=8:H-h-8{label}[c{i}];")
    f += "[c0][c1][c2][c3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0"
    if gif:
        f += ",split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    return f


def build_grid(width=480):
    inputs = [p for move in CLIPS for p in (paths(move)[3], paths(move)[0])]
    missing = [str(p) for p in inputs if not p.exists()]
    if missing:
        sys.exit(f"missing clips: {', '.join(missing)}")
    args = [a for p in inputs for a in ("-i", str(p))]
    mp4 = EX / "four_moves.mp4"
    gif = ROOT / "docs" / "media" / "four_moves.gif"
    font = font_option()
    subprocess.run([ffmpeg(), "-v", "error", "-y", *args, "-filter_complex", grid_filter(width, font=font),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-an", str(mp4)], check=True)
    subprocess.run([ffmpeg(), "-v", "error", "-y", *args, "-filter_complex", grid_filter(320, fps=12, gif=True, font=font),
                    "-loop", "0", str(gif)], check=True)
    print(f"wrote {mp4} and {gif} ({gif.stat().st_size / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print the commands, run nothing")
    ap.add_argument("--grid-only", action="store_true", help="skip rendering; build the grid from existing renders")
    args = ap.parse_args()
    if not args.grid_only:
        for cmd in render_commands():
            print("+", " ".join(cmd[1:]), flush=True)
            if not args.dry_run:
                subprocess.run(cmd, check=True, cwd=ROOT)
    if not args.dry_run:
        build_grid()


if __name__ == "__main__":
    main()
