"""A stand-in ComfyUI for local tests: no GPU, no models, $0.

It speaks the native endpoints comfy-api-proxy uses (/prompt, /history, /queue, /view,
/upload/image, /api/jobs/{id}/cancel, /ws), checks submitted graphs against the inputs of the core
nodes our workflows use (so wiring mistakes fail here, not on a paid GPU), and "renders" by copying
the uploaded layout clip to the SaveVideo output (and the uploaded depth map to the SaveImage output).

    python -m server.mock_comfyui --port 8188
    comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189
    COMFY_BASE_URL=http://127.0.0.1:8189 python -m server.app

A prompt containing MOCK_FAIL makes the run fail like a node error would.
Modelled on comfy-api-proxy's demo/fake_comfyui.py (MIT).
"""

import argparse
import asyncio
import json
import shutil
import tempfile
import uuid
from pathlib import Path

from aiohttp import WSMsgType, web

# Required inputs of each core node class our graphs use (ComfyUI master, Oct 2026).
REQUIRED = {
    "UNETLoader": ["unet_name", "weight_dtype"],
    "CLIPLoader": ["clip_name", "type"],
    "VAELoader": ["vae_name"],
    "LoraLoaderModelOnly": ["model", "lora_name", "strength_model"],
    "GetICLoRAParameters": ["iclora_model"],
    "LoadVideo": ["file"],
    "GetVideoComponents": ["video"],
    "LoadImage": ["image"],
    "LTXVPreprocess": ["image", "img_compression"],
    "CLIPTextEncode": ["text", "clip"],
    "LTXVConditioning": ["positive", "negative", "frame_rate"],
    "EmptyLTXVLatentVideo": ["width", "height", "length", "batch_size"],
    "LTXVEmptyLatentAudio": ["frames_number", "frame_rate", "batch_size", "audio_vae"],
    "LTXVImgToVideoInplace": ["vae", "image", "latent", "strength"],
    "LTXVAddGuide": ["positive", "negative", "vae", "latent", "image", "frame_idx", "strength"],
    "LTXVConcatAVLatent": ["video_latent", "audio_latent"],
    "RandomNoise": ["noise_seed"],
    "KSamplerSelect": ["sampler_name"],
    "ManualSigmas": ["sigmas"],
    "LTXVDualCFGGuider": ["model", "positive", "negative", "video_cfg", "audio_cfg"],
    "SamplerCustomAdvanced": ["noise", "guider", "sampler", "sigmas", "latent_image"],
    "LTXVSeparateAVLatent": ["av_latent"],
    "LTXVCropGuides": ["positive", "negative", "latent"],
    "VAEDecodeTiled": ["samples", "vae", "tile_size", "overlap", "temporal_size", "temporal_overlap"],
    "LTXVAudioVAEDecode": ["samples", "audio_vae"],
    "CreateVideo": ["images", "fps"],
    "SaveVideo": ["video", "filename_prefix", "format"],
    # stage 2 (x2 latent upscale + refine)
    "LatentUpscaleModelLoader": ["model_name"],
    "LTXVLatentUpsampler": ["samples", "upscale_model", "vae"],
    # look still (Z-Image-Turbo + Fun ControlNet Union)
    "ModelPatchLoader": ["name"],
    "ImageScale": ["image", "upscale_method", "width", "height", "crop"],
    "QwenImageDiffsynthControlnet": ["model", "model_patch", "vae", "image", "strength"],
    "ModelSamplingAuraFlow": ["model", "shift"],
    "ConditioningZeroOut": ["conditioning"],
    "EmptySD3LatentImage": ["width", "height", "batch_size"],
    "KSampler": ["model", "seed", "steps", "cfg", "sampler_name", "scheduler", "positive", "negative",
                 "latent_image", "denoise"],
    "VAEDecode": ["samples", "vae"],
    "SaveImage": ["images", "filename_prefix"],
}
# How many outputs each class has, to catch links to a slot that doesn't exist.
OUTPUTS = {"LTXVConditioning": 2, "GetVideoComponents": 3, "LTXVAddGuide": 3, "LTXVSeparateAVLatent": 2,
           "LTXVCropGuides": 3, "LoadImage": 2}


def validate(graph, inputs_dir):
    """Return ComfyUI-style node_errors ({} when the graph is fine)."""
    errors = {}

    def err(nid, msg):
        errors.setdefault(nid, {"errors": [], "class_type": graph[nid].get("class_type")})["errors"].append(
            {"type": "invalid", "message": msg, "details": ""})

    for nid, node in graph.items():
        ct = node.get("class_type")
        if ct not in REQUIRED:
            err(nid, f"unknown node class {ct!r}")
            continue
        ins = node.get("inputs", {})
        for name in REQUIRED[ct]:
            if name not in ins:
                err(nid, f"missing required input {name!r}")
        for name, v in ins.items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                src = graph.get(v[0])
                if src is None:
                    err(nid, f"{name} links to missing node {v[0]}")
                elif v[1] >= OUTPUTS.get(src.get("class_type"), 1):
                    err(nid, f"{name} links to output {v[1]} of {src['class_type']}, which has fewer")
        for name in ("file", "image"):
            if ct in ("LoadVideo", "LoadImage") and name in ins and not (inputs_dir / str(ins[name])).is_file():
                err(nid, f"input file {ins[name]!r} was not uploaded")
    return errors


class MockComfy:
    def __init__(self, root=None, delay=0.3):
        self.root = Path(root or tempfile.mkdtemp(prefix="mock-comfy-"))
        self.inputs = self.root / "input"
        self.outputs = self.root / "output"
        self.inputs.mkdir(parents=True, exist_ok=True)
        self.outputs.mkdir(parents=True, exist_ok=True)
        self.delay = delay
        self.jobs = {}  # prompt_id -> {"state", "graph", "client_id", "outputs", "error"}
        self.counter = 0

    def app(self):
        app = web.Application(client_max_size=200 * 1024 * 1024)
        app.add_routes([
            web.post("/prompt", self.prompt),
            web.get("/history/{id}", self.history),
            web.get("/queue", self.queue),
            web.get("/view", self.view),
            web.post("/upload/image", self.upload),
            web.post("/api/jobs/{id}/cancel", self.cancel),
            web.get("/ws", self.ws),
        ])
        return app

    async def prompt(self, request):
        body = await request.json()
        pid = str(body.get("prompt_id") or uuid.uuid4())
        graph = body.get("prompt") or {}
        node_errors = validate(graph, self.inputs)
        if node_errors:
            return web.json_response({"error": {"type": "prompt_outputs_failed_validation",
                                                "message": "Prompt outputs failed validation"},
                                      "node_errors": node_errors}, status=400)
        self.jobs[pid] = {"state": "running", "graph": graph, "client_id": body.get("client_id"),
                          "outputs": {}, "error": None}
        asyncio.get_running_loop().create_task(self._render(pid))
        return web.json_response({"prompt_id": pid, "number": len(self.jobs), "node_errors": {}})

    async def _render(self, pid):
        await asyncio.sleep(self.delay)
        job = self.jobs[pid]
        if job["state"] != "running":
            return
        graph = job["graph"]
        prompt = " ".join(str(n["inputs"].get("text", "")) for n in graph.values() if n["class_type"] == "CLIPTextEncode")
        if "MOCK_FAIL" in prompt:
            job["error"] = {"node_id": "44", "node_type": "SamplerCustomAdvanced",
                            "exception_message": "mock failure (MOCK_FAIL in prompt)"}
            job["state"] = "error"
            return
        for nid, node in graph.items():
            ct = node["class_type"]
            if ct not in ("SaveVideo", "SaveImage"):
                continue
            # "render": the layout clip comes back as the video, the (depth) input image as the still
            loader, field, ext = ("LoadVideo", "file", ".mp4") if ct == "SaveVideo" else ("LoadImage", "image", ".png")
            src = next(n["inputs"][field] for n in graph.values() if n["class_type"] == loader)
            self.counter += 1
            prefix = Path(node["inputs"]["filename_prefix"])
            name = f"{prefix.name}_{self.counter:05d}_{ext}"
            sub = prefix.parent.as_posix() if str(prefix.parent) != "." else ""
            (self.outputs / sub).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.inputs / src, self.outputs / sub / name)
            job["outputs"][nid] = {"images": [{"filename": name, "subfolder": sub, "type": "output"}]}
            if ct == "SaveVideo":
                job["outputs"][nid]["animated"] = [True]
        job["state"] = "success"

    async def history(self, request):
        pid = request.match_info["id"]
        job = self.jobs.get(pid)
        if not job or job["state"] == "running":
            return web.json_response({})
        if job["state"] == "success":
            status = {"status_str": "success", "completed": True, "messages": [["execution_cached", {"nodes": []}]]}
        elif job["state"] == "interrupted":
            status = {"status_str": "error", "completed": False, "messages": [["execution_interrupted", {}]]}
        else:
            status = {"status_str": "error", "completed": False, "messages": [["execution_error", job["error"]]]}
        return web.json_response({pid: {"outputs": job["outputs"], "status": status}})

    async def queue(self, request):
        running = [[i, pid] for i, (pid, j) in enumerate(self.jobs.items()) if j["state"] == "running"]
        return web.json_response({"queue_running": running, "queue_pending": []})

    async def view(self, request):
        q = request.query
        base = self.inputs if q.get("type") == "input" else self.outputs
        path = (base / q.get("subfolder", "") / q.get("filename", "")).resolve()
        if base.resolve() not in path.parents or not path.is_file():
            return web.Response(status=404)
        return web.FileResponse(path)

    async def upload(self, request):
        post = await request.post()
        f = post.get("image")
        if f is None or not getattr(f, "filename", None):
            return web.Response(status=400, text="no image")
        sub = str(post.get("subfolder", "") or "")
        name = Path(f.filename).name
        (self.inputs / sub).mkdir(parents=True, exist_ok=True)
        (self.inputs / sub / name).write_bytes(f.file.read())
        return web.json_response({"name": name, "subfolder": sub, "type": "input"})

    async def cancel(self, request):
        job = self.jobs.get(request.match_info["id"])
        if job and job["state"] == "running":
            job["state"] = "interrupted"
            return web.json_response({"cancelled": True})
        return web.json_response({"cancelled": False})

    async def ws(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        client_id = request.query.get("clientId")
        async for msg in ws:  # feature_flags handshake: client first, then us
            if msg.type == WSMsgType.TEXT and json.loads(msg.data).get("type") == "feature_flags":
                await ws.send_json({"type": "feature_flags", "data": {}})
                break
            if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                return ws
        pid = next((p for p, j in self.jobs.items() if j["state"] == "running" and j["client_id"] == client_id), None)
        if pid:
            for step in range(1, 9):
                await ws.send_json({"type": "progress", "data": {"value": step, "max": 8, "node": "44", "prompt_id": pid}})
                await asyncio.sleep(self.delay / 10)
            for _ in range(400):
                state = self.jobs[pid]["state"]
                if state == "success":
                    await ws.send_json({"type": "execution_success", "data": {"prompt_id": pid}})
                    break
                if state in ("error", "interrupted"):
                    kind = "execution_error" if state == "error" else "execution_interrupted"
                    await ws.send_json({"type": kind, "data": {"prompt_id": pid, **(self.jobs[pid]["error"] or {})}})
                    break
                await asyncio.sleep(0.05)
        await ws.close()
        return ws


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8188)
    ap.add_argument("--delay", type=float, default=3.0, help="seconds a fake render takes")
    args = ap.parse_args()
    mock = MockComfy(delay=args.delay)
    print(f"mock ComfyUI on http://127.0.0.1:{args.port} (files in {mock.root})")
    web.run_app(mock.app(), host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
