#!/usr/bin/env python3
"""Cuts the demo video: the editor beats recorded by record.mjs plus the real A40 renders in examples/,
in the order and timings of docs/submission/DEMO_SCRIPT.md, with captions. No GPU needed.

    python scripts/demo/assemble.py            # reads demo/raw/, writes demo/demo.mp4 (1920x1080, 24 fps)

Each part is encoded on its own (H.264, same settings), then the parts are joined without re-encoding.
An editor beat longer than its slot is sped up to fit (a slow software-GL browser records slowly); a
shorter one holds its last frame. If the recording has no playblast beat (Playwright's Chromium can't
encode H.264), that slot shows the bundled plaza playblast instead.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EX = ROOT / "examples"
W, H, FPS = 1920, 1080, 24
MAX_SECONDS = 120.0

# The frame: pictures above, a caption band below.
BAND_Y = 940  # top of the caption band
BG = "0x111317"
TITLE = "Open Cinema Studio"
LIVE_LINK = "colinwww.github.io/open-cinema-studio"
REPO = "github.com/ColinWWW/open-cinema-studio"


def find_font(bold: bool = False) -> str | None:
    """A TTF for drawtext: fontconfig's pick, else a few usual paths (None: drawtext's default font)."""
    if shutil.which("fc-match"):
        r = subprocess.run(["fc-match", "-f", "%{file}", "DejaVu Sans:bold" if bold else "DejaVu Sans"],
                           capture_output=True, text=True)
        if r.returncode == 0 and Path(r.stdout).is_file():
            return r.stdout
    names = ["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"] if bold else ["DejaVuSans.ttf", "Arial.ttf", "arial.ttf"]
    for d in ["/usr/share/fonts/truetype/dejavu", "/Library/Fonts", "/System/Library/Fonts/Supplemental", "C:/Windows/Fonts"]:
        for n in names:
            if (Path(d) / n).is_file():
                return str(Path(d) / n)
    return None


def esc(path: Path | str) -> str:
    """A path as a filtergraph option value."""
    return str(path).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


@dataclass
class Media:
    """One picture in a part: a clip (looped to fill the part) or a still, placed at x,y and scaled to w x h."""

    path: Path
    x: int
    y: int
    w: int
    h: int
    label: str = ""
    start: float = 0.0  # editor beats: where the beat starts in the recording
    length: float = 0.0  # ... and how long it is (0: the whole file, looped)


@dataclass
class Part:
    seconds: float
    caption: str
    media: list[Media] = field(default_factory=list)
    text: list[tuple[str, int, int, bool]] = field(default_factory=list)  # (text, size, y, bold), centred


class Builder:
    def __init__(self, tmp: Path, fonts: tuple[str | None, str | None]):
        self.tmp = tmp
        self.font, self.bold = fonts
        self.n = 0

    def drawtext(self, text: str, size: int, x: str, y: str | int, bold: bool = False, box: bool = False) -> str:
        self.n += 1
        f = self.tmp / f"text{self.n}.txt"
        f.write_text(text, encoding="utf-8")
        font = self.bold if bold else self.font
        opts = [f"textfile='{esc(f)}'", f"fontsize={size}", "fontcolor=white", f"x={x}", f"y={y}"]
        if font:
            opts.append(f"fontfile='{esc(font)}'")
        if box:
            opts += ["box=1", "boxcolor=black@0.55", "boxborderw=10"]
        return "drawtext=" + ":".join(opts)

    def encode(self, part: Part, out: Path) -> None:
        args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={BG}:s={W}x{H}:r={FPS}:d={part.seconds}"]
        chains, last = [], "0:v"
        for i, m in enumerate(part.media, start=1):
            still = m.path.suffix.lower() in (".png", ".jpg", ".jpeg")
            if still:
                args += ["-loop", "1", "-framerate", str(FPS), "-t", str(part.seconds), "-i", str(m.path)]
                pre = ""
            elif m.length:
                args += ["-ss", f"{m.start:.3f}", "-t", f"{m.length:.3f}", "-i", str(m.path)]
                speed = max(1.0, m.length / part.seconds)
                pre = f"setpts=(PTS-STARTPTS)/{speed:.4f},fps={FPS},tpad=stop_mode=clone:stop_duration={part.seconds},"
            else:
                args += ["-stream_loop", "-1", "-i", str(m.path)]
                pre = f"setpts=PTS-STARTPTS,fps={FPS},"
            chains.append(f"[{i}:v]{pre}scale={m.w}:{m.h}:flags=lanczos,setsar=1[m{i}]")
            chains.append(f"[{last}][m{i}]overlay=x={m.x}:y={m.y}:shortest=0:eof_action=repeat[o{i}]")
            last = f"o{i}"
        draws = []
        for m in part.media:
            if m.label:
                draws.append(self.drawtext(m.label, 30, str(m.x + 14), m.y + 12, box=True))
        for text, size, y, bold in part.text:
            draws.append(self.drawtext(text, size, "(w-text_w)/2", y, bold=bold))
        lines = textwrap.wrap(part.caption, 72)
        top = BAND_Y + (H - BAND_Y - 48 * len(lines)) // 2
        for k, line in enumerate(lines):
            draws.append(self.drawtext(line, 38, "(w-text_w)/2", top + 48 * k))
        chains.append(f"[{last}]" + ",".join(draws + ["format=yuv420p"]) + "[v]")
        args += ["-filter_complex", ";".join(chains), "-map", "[v]", "-t", str(part.seconds), "-r", str(FPS),
                 "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
                 "-video_track_timescale", "12288", str(out)]
        subprocess.run(args, check=True)


# Layouts inside the picture area (0..BAND_Y).
def two_up(left: Path, right: Path, labels: tuple[str, str]) -> list[Media]:
    w, h = 930, 558  # 960x576 scaled
    y = (BAND_Y - h) // 2
    return [Media(left, 20, y, w, h, labels[0]), Media(right, W - 20 - w, y, w, h, labels[1])]


def grid(cells: list[tuple[Path, str]]) -> list[Media]:
    w, h = 755, 453
    x0, y0, gap = (W - 2 * w - 16) // 2, (BAND_Y - 2 * h - 16) // 2, 16
    return [Media(p, x0 + (k % 2) * (w + gap), y0 + (k // 2) * (h + gap), w, h, label) for k, (p, label) in enumerate(cells)]


def editor(raw: Path, beat: dict) -> list[Media]:
    """The recorded browser (1920x1080), shrunk into the picture area."""
    h = BAND_Y - 24
    w = round(h * 16 / 9)
    return [Media(raw / "editor.webm", (W - w) // 2, 12, w, h, start=beat["start"], length=beat["end"] - beat["start"])]


def parts(raw: Path) -> list[Part]:
    """The shot list of DEMO_SCRIPT.md: keep the two in step."""
    beats = {b["name"]: b for b in json.loads((raw / "beats.json").read_text())["beats"]}
    layout, render = EX / "layout_plaza_dolly_in.mp4", EX / "stage1_day_plaza_a40.mp4"  # the day look, sky kept
    # the scene record.mjs blocks at 0:08 (plaza + a box and a person, Orbit right), rendered on the A40
    scene_layout, scene_render = EX / "layout_demo_scene.mp4", EX / "stage1_demo_scene_a40.mp4"
    frame0, depth = EX / "layout_plaza_dolly_in_first.png", EX / "layout_plaza_dolly_in_depth.png"
    sbs = ("Grey layout, blocked in the browser", "LTX-2.5 render (A40)")
    out = [
        # 0:00 Hook
        Part(8, "Block a shot with grey boxes. Get back a cinematic clip that moves exactly like it. "
                "Open weights only.", two_up(layout, render, sbs)),
        # 0:08 Block
        Part(22, "A three.js blocking tool in the browser: place stand-ins, frame the shot, key the camera "
                 "or pick a move.", editor(raw, beats["block"])),
    ]
    # 0:30 Playblast
    still_row = [Media(layout, 30, 250, 600, 360, "Layout clip (MP4)"), Media(frame0, 660, 250, 600, 360, "Frame 0"),
                 Media(depth, 1290, 250, 600, 360, "Depth (frame 0)")]
    cap = "It exports an on-spec layout clip and frame 0's depth, right in the browser."
    if "playblast" in beats:
        out += [Part(6, cap, editor(raw, beats["playblast"])), Part(4, cap, still_row)]
    else:
        out += [Part(10, cap, still_row)]
    look_cap = ("Z-Image-Turbo with a depth ControlNet paints the first frame from the layout's own depth, "
                "so it lines up box for box.")
    out += [
        # 0:40 Art-direct
        Part(10, look_cap, editor(raw, beats["render"])),
        Part(10, look_cap, grid([(depth, "Depth (frame 0)"), (EX / "look_day_plaza.png", "Look still: sunny day"),
                                 (EX / "look_night_plaza.png", "Rainy night"), (EX / "look_snow_plaza.png", "Snowy dusk")])),
        # 1:00 Render
        Part(8, "LTX-2.5 with the Layout-to-Render IC-LoRA follows the layout's camera and blocking and takes "
                "the look from that frame. About 3 minutes on an A40.",
             two_up(scene_layout, scene_render, ("The shot blocked above", "Its LTX-2.5 render (A40)"))),
        Part(7, "Stage 2: an x2 latent upscale and 3 refine steps to 1920x1088, 97 frames in about 6 minutes.",
             [Media(EX / "two_stage_day_plaza_1920_a40.mp4", (W - 1568) // 2, (BAND_Y - 888) // 2, 1568, 888,
                    "Stage 2, 1920x1088 (A40)")]),
        # 1:15 A scene, not a clip
        Part(15, "Add shots, order the cut, render the whole scene: one blocking, several cameras, one sequence.",
             two_up(EX / "sequence_plaza_4shots_layout.mp4", EX / "sequence_plaza_4shots_a40.mp4",
                    ("4-shot layout sequence", "4-shot render (A40)"))),
        # 1:30 Same blocking, any look (three_looks_plaza.mp4 is already a 2x2: layout, day, night, snow)
        Part(15, "Same blocking, three looks. Change the prompt, not the shot.",
             [Media(EX / "three_looks_plaza.mp4", (W - 1500) // 2, 20, 1500, 900)]),
        # 1:45 How it's built (ends a little before 2:00)
        Part(14.5, "Built on the Comfy SDK with our own core-node workflows, on Comfy Cloud or your own GPU. "
                   "MIT licensed. Try it at the link.",
             [Media(layout, 330, 60, 600, 360), Media(render, 990, 60, 600, 360)],
             [(TITLE, 84, 500, True),
              ("Comfy SDK  ·  core-node workflows  ·  open weights only  ·  MIT", 38, 630, False),
              (f"Try it: {LIVE_LINK}", 44, 730, True),
              (REPO, 34, 810, False)]),
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--raw", type=Path, default=ROOT / "demo" / "raw", help="record.mjs output (default demo/raw)")
    ap.add_argument("-o", "--out", type=Path, default=ROOT / "demo" / "demo.mp4")
    a = ap.parse_args()
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH")
    if not (a.raw / "beats.json").is_file():
        sys.exit(f"{a.raw / 'beats.json'} is missing: run node scripts/demo/record.mjs first")

    a.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ocs-demo-") as t:
        tmp = Path(t)
        b = Builder(tmp, (find_font(), find_font(bold=True)))
        files = []
        clock = 0.0
        for k, part in enumerate(parts(a.raw)):
            f = tmp / f"part{k:02d}.mp4"
            print(f"{int(clock // 60)}:{clock % 60:04.1f}  {part.seconds:>4}s  {part.caption[:60]}")
            b.encode(part, f)
            files.append(f)
            clock += part.seconds
        lst = tmp / "parts.txt"
        lst.write_text("".join(f"file '{f.as_posix()}'\n" for f in files))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy",
                        "-movflags", "+faststart", str(a.out)], check=True)

    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(a.out)],
                           capture_output=True, text=True, check=True)
    seconds = float(probe.stdout)
    print(f"Wrote {a.out} ({seconds:.1f} s, {W}x{H}, {FPS} fps)")
    if seconds > MAX_SECONDS:
        print(f"error: longer than {MAX_SECONDS:.0f} s", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
