"""Cut clips together, in order, into one MP4 (a sequence of shots). No re-encode: the clips come from
the same workflow (or the same playblast exporter), so they share codec, size and frame rate.

    python -m server.stitch shot1.mp4 shot2.mp4 shot3.mp4 -o sequence.mp4
"""

import argparse
import asyncio
import shutil
import sys
from pathlib import Path


def ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def concat_list(paths):
    """ffmpeg concat-demuxer script for these files (absolute paths, quotes escaped)."""
    lines = ["ffconcat version 1.0"]
    for p in paths:
        lines.append("file '" + str(Path(p).resolve()).replace("'", "'\\''") + "'")
    return "\n".join(lines) + "\n"


async def stitch(paths, out):
    """Write the clips in `paths`, back to back, to `out`. Raises RuntimeError if ffmpeg fails."""
    if len(paths) < 2:
        raise ValueError("stitch needs at least two clips")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    script = out.with_suffix(".txt")
    script.write_text(concat_list(paths), encoding="utf-8")
    proc = await asyncio.create_subprocess_exec(
        ffmpeg(), "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(script),
        "-c", "copy", "-movflags", "+faststart", str(out),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    script.unlink(missing_ok=True)
    if proc.returncode or err.strip():  # -v error: anything printed is an error (a bad clip gets skipped, exit 0)
        out.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg could not join the clips: {err.decode(errors='replace').strip()[-300:]}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Join clips into one MP4, in order, without re-encoding")
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path, required=True)
    args = ap.parse_args(argv)
    try:
        asyncio.run(stitch(args.clips, args.out))
    except (ValueError, RuntimeError) as e:
        sys.exit(str(e))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
