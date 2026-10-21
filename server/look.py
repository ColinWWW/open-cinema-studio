"""Make a look still from the playblast's frame-0 depth map through the Comfy SDK.

    python -m server.look web/exports/Plaza_960x576_65f_depth.png "A sunny stone plaza ..." -o look.png

Same targets as server.render (COMFY_BASE_URL / COMFY_API_KEY). The still comes back at the depth
map's size, which is the playblast's size, ready for `python -m server.render`.
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

from comfy_sdk import AsyncComfy

from .render import png_size, prompt_warnings, render_look, tolerate_head_rewrites
from .workflow import look_size


def main(argv=None):
    ap = argparse.ArgumentParser(description="Depth-controlled look still (Z-Image-Turbo) via the Comfy SDK")
    ap.add_argument("depth", help="depth map of frame 0 (PNG, near = white, playblast size)")
    ap.add_argument("prompt")
    ap.add_argument("-o", "--out", default="look.png")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--strength", type=float, default=1.0, help="depth control strength (0.65-1.0)")
    args = ap.parse_args(argv)

    w, h = png_size(Path(args.depth).read_bytes())
    for warning in prompt_warnings(args.prompt):
        print("warning:", warning, file=sys.stderr)

    async def run():
        t0 = time.time()
        async with AsyncComfy() as client:
            tolerate_head_rewrites(client)
            print(f"target: {client!r}, still {w}x{h}, generated at {look_size(w, h)}")
            _, job_id = await render_look(client, args.depth, args.prompt, width=w, height=h, seed=args.seed,
                                          strength=args.strength, out=args.out,
                                          on_progress=lambda **kw: print(" ", kw))
        print(f"job {job_id}: wrote {args.out} in {time.time() - t0:.1f}s")

    asyncio.run(run())


if __name__ == "__main__":
    main()
