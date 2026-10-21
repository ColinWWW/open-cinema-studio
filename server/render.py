"""Run one stage-1 render through the Comfy SDK: layout clip + look still + prompt -> MP4.

The SDK targets Comfy Cloud by default; set COMFY_BASE_URL to run elsewhere:
    COMFY_BASE_URL=http://127.0.0.1:8189   self-hosted ComfyUI behind comfy-api-proxy (RunPod, mock)
    COMFY_API_KEY=comfyui-...             needed for Comfy Cloud / Comfy API deployments

    python -m server.render examples/layout_plaza_dolly_in.mp4 examples/look_plaza_960x576.png \
        "A sunny plaza ..." -o examples/render.mp4

Each submit is a new paid job, so nothing here retries a submit.
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

from comfy_sdk import AsyncComfy, OutputReady, Progress, StatusChange

from .workflow import LOOK_NODES, NODES, build_look_still, build_stage1, check_dims, stage1_size

BANNED_WORDS = ("clay", "3d", "unreal")  # the model card: never describe the layout itself


def tolerate_head_rewrites(client):
    """Make the SDK work through an HTTP reverse proxy such as RunPod's
    (https://<pod>-8189.proxy.runpod.net in front of comfy-api-proxy). Two things break there:
    - the dedup check `HEAD /api/v2/assets/by-hash/...` comes back 405: treat that as "not on the
      server yet", so the SDK falls through to a normal upload;
    - comfy-api-proxy builds its follow-up links (job.urls.self, ...) from the Host it sees, which
      is the pod's internal address: send /api/v2 links on another host back through our base URL.
    Comfy Cloud and a local proxy answer both normally, so nothing changes there."""
    from urllib.parse import urlsplit

    low = client._low
    prep = low._p
    base = urlsplit(prep.base_url)
    original_url, original_head = prep.url, low.head_asset_by_hash

    def url(path):
        u = urlsplit(path) if path.startswith("http") else None
        if u and u.netloc != base.netloc and u.path.startswith("/api/v2/"):
            path = u.path + (f"?{u.query}" if u.query else "")
        return original_url(path)

    async def head_asset_by_hash(digest, **kw):
        resp = await low.raw_request("HEAD", f"/assets/by-hash/{digest}")
        if resp.status_code == 405:
            return False
        return await original_head(digest, **kw)

    prep.url = url
    low.head_asset_by_hash = head_asset_by_hash
    return client


def png_size(data):
    """(width, height) from a PNG's IHDR chunk; ValueError if `data` isn't a PNG."""
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("not a PNG file")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def prompt_warnings(prompt):
    words = prompt.lower().replace(",", " ").replace(".", " ").split()
    return [f"avoid the word {w!r} in the prompt (describe the finished shot)" for w in BANNED_WORDS if w in words]


async def _run(client, wf, output_node, kind, *, out=None, on_progress=None):
    """Submit once, follow progress, download the first `kind` ("video"/"image") output of `output_node`.
    Returns (bytes, comfy job id)."""
    report = on_progress or (lambda **kw: None)
    report(stage="uploading")
    job = await client.submit(wf)
    report(stage="queued", job_id=job.id)

    async def follow():  # live progress only; job.result() below is the authority
        try:
            async for ev in job.events():
                if isinstance(ev, Progress):
                    report(stage="rendering", progress=ev.value)
                elif isinstance(ev, StatusChange):
                    report(stage=ev.status)
                elif isinstance(ev, OutputReady):
                    report(stage="saving")
        except Exception:  # noqa: BLE001 - a dropped stream must not fail the render
            pass

    follower = asyncio.create_task(follow())
    try:
        await job.result()  # raises JobFailed with the node error
    finally:
        follower.cancel()
    ext = ".mp4" if kind == "video" else ".png"
    outputs = [o for o in job.get_outputs(output_node) if o.content_type.startswith(f"{kind}/") or o.name.endswith(ext)]
    if not outputs:
        raise RuntimeError(f"job {job.id} finished without an {kind} from node {output_node}")
    data = await outputs[0].to_bytes()
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(data)
    return data, job.id


async def render(client, layout, look, prompt, *, width, height, frames, seed=42, out=None, on_progress=None):
    """Upload inputs, run the graph, download the clip. Returns (mp4 bytes, comfy job id)."""
    check_dims(width, height, frames)
    if not prompt.strip():
        raise ValueError("prompt is empty")
    w, h = stage1_size(width, height)
    wf = client.workflows.from_json(build_stage1(prompt=prompt, width=w, height=h, frames=frames, seed=seed))
    wf.set_input(NODES["layout"], "file", client.assets.from_file(layout))
    wf.set_input(NODES["look"], "image", client.assets.from_file(look))
    return await _run(client, wf, NODES["output"], "video", out=out, on_progress=on_progress)


async def render_look(client, depth, prompt, *, width, height, seed=42, strength=1.0, out=None, on_progress=None):
    """Depth map of frame 0 + prompt -> a look still (PNG bytes at width x height), comfy job id."""
    if not prompt.strip():
        raise ValueError("prompt is empty")
    wf = client.workflows.from_json(build_look_still(prompt=prompt, width=width, height=height, seed=seed,
                                                     strength=strength))
    wf.set_input(LOOK_NODES["depth"], "image", client.assets.from_file(depth))
    return await _run(client, wf, LOOK_NODES["output"], "image", out=out, on_progress=on_progress)


def _probe(path):
    """width, height, frames of an MP4 via imageio-ffmpeg (no full decode)."""
    import imageio_ffmpeg

    reader = imageio_ffmpeg.read_frames(str(path))
    meta = next(reader)
    reader.close()
    w, h = meta["size"]
    frames, _ = imageio_ffmpeg.count_frames_and_secs(str(path))
    return w, h, frames


def main(argv=None):
    ap = argparse.ArgumentParser(description="Stage-1 Layout-to-Render via the Comfy SDK")
    ap.add_argument("layout", help="layout playblast MP4 (24 fps, /64 dims, 8k+1 frames)")
    ap.add_argument("look", help="look still for frame 0 (PNG/JPG, same framing as the layout)")
    ap.add_argument("prompt")
    ap.add_argument("-o", "--out", default="render.mp4")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    w, h, frames = _probe(args.layout)
    for warning in prompt_warnings(args.prompt):
        print("warning:", warning, file=sys.stderr)

    async def run():
        t0 = time.time()
        async with AsyncComfy() as client:
            tolerate_head_rewrites(client)
            print(f"target: {client!r}, layout {w}x{h} x {frames}, stage 1 at {stage1_size(w, h)}")
            _, job_id = await render(client, args.layout, args.look, args.prompt, width=w, height=h,
                                     frames=frames, seed=args.seed, out=args.out,
                                     on_progress=lambda **kw: print(" ", kw))
        print(f"job {job_id}: wrote {args.out} in {time.time() - t0:.1f}s")

    asyncio.run(run())


if __name__ == "__main__":
    main()
