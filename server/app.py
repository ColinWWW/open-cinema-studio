"""Local render server for web/: POST a playblast, a look still and a prompt, get a clip back.

    COMFY_BASE_URL=http://127.0.0.1:8189 python -m server.app      # self-hosted ComfyUI (proxy)
    COMFY_API_KEY=comfyui-... python -m server.app                 # Comfy Cloud

Routes (the Vite dev server proxies them here):
    GET  /api/health              which Comfy target the SDK is pointed at
    POST /api/render              multipart: layout (mp4), look (image), prompt, width, height, frames, seed?
                                  -> 202 {"id"}
    GET  /api/render/{id}         {"status": queued|running|succeeded|failed, "stage", "progress", "error", ...}
    GET  /api/render/{id}/video   the finished MP4
    POST /api/look                multipart: depth (png, frame 0, near = white), prompt, width, height, seed?,
                                  strength? -> 202 {"id"}   (depth-controlled look still, Z-Image-Turbo)
    GET  /api/look/{id}           same status fields as a render
    GET  /api/look/{id}/image     the finished PNG, at width x height
    POST /api/{render|look}/{id}/cancel   stop a queued or running job (status becomes "cancelled")
    POST /api/stitch              JSON {"renders": [id, ...], "clip": "render"|"layout"} -> 201, a finished
                                  "sequence" job: those renders (or their layout clips) cut together in order
    GET  /api/sequence/{id}/video the joined MP4

A page served from another origin (e.g. GitHub Pages) can call the server when it's started with
--cors-origin https://colinwww.github.io: CORS headers (and preflight answers) go to that origin only.
Give --cors-origin more than once to let several pages in (server.local does: the live page and the dev server).

Jobs (renders and looks) run one at a time (one GPU), in submission order. Files go to server/renders/<id>/.
Only the newest --keep-jobs finished jobs (default 200) are kept, with their folders; queued and running jobs,
and renders that a kept sequence was cut from, are never pruned.
"""

import argparse
import asyncio
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web
from comfy_sdk import AsyncComfy, ComfyError

from .render import png_size, prompt_warnings, render, render_look, tolerate_head_rewrites
from .stitch import stitch
from .workflow import check_dims, look_size

RENDERS = Path(__file__).resolve().parent / "renders"
MAX_UPLOAD = 200 * 1024 * 1024
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}
KEEP_JOBS = 200
FINISHED = ("succeeded", "failed", "cancelled")
SERVICE = web.AppKey("service", object)
log = logging.getLogger(__name__)


class RenderService:
    """Render and look-still jobs share one queue (one GPU) and one id space."""

    RESULTS = {"render": ("render.mp4", "video"), "look": ("look.png", "image"),
               "sequence": ("sequence.mp4", "video")}
    MAX_SHOTS = 24

    def __init__(self, client, renders_dir=RENDERS, keep_jobs=KEEP_JOBS):
        self.client = client
        self.dir = Path(renders_dir)
        self.keep_jobs = keep_jobs  # 0: keep everything
        self.jobs = {}
        self.lock = asyncio.Lock()  # one job at a time
        self._prune_old_folders()

    def _prune_old_folders(self):
        """Job folders left by an earlier run (no job knows them any more): keep the newest keep_jobs."""
        if not self.keep_jobs or not self.dir.is_dir():
            return
        old = [d for d in self.dir.iterdir() if d.is_dir() and re.fullmatch(r"[0-9a-f]{12}", d.name)]
        old.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        for d in old[self.keep_jobs:]:
            shutil.rmtree(d, ignore_errors=True)

    def prune(self):
        """Drop finished jobs (and their folders) older than the newest keep_jobs. Queued and running jobs stay,
        and so does any render that a remaining sequence was cut from (it goes once that sequence has)."""
        if not self.keep_jobs:
            return
        finished = sorted((j for j in self.jobs.values() if j["status"] in FINISHED), key=lambda j: j.get("created", 0))
        old = [j["id"] for j in finished[:-self.keep_jobs]]
        while old:
            needed = {r for j in self.jobs.values() if j["kind"] == "sequence" for r in j.get("renders", ())}
            drop = [rid for rid in old if rid not in needed]
            if not drop:
                return
            for rid in drop:
                shutil.rmtree(self.jobs.pop(rid)["_folder"], ignore_errors=True)
            old = [rid for rid in old if rid in needed]

    def public(self, rid):
        job = self.jobs[rid]
        out = {k: v for k, v in job.items() if not k.startswith("_")}
        out["elapsed"] = round(time.time() - job["created"], 1)  # server clock, so the page needn't trust its own
        if job["status"] == "succeeded":
            _, what = self.RESULTS[job["kind"]]
            out[f"{what}_url"] = f"/api/{job['kind']}/{rid}/{what}"
        return out

    def result_path(self, rid):
        job = self.jobs[rid]
        return job["_folder"] / self.RESULTS[job["kind"]][0]

    def _new(self, kind, prompt):
        if not prompt.strip():
            raise ValueError("prompt is empty")
        rid = uuid.uuid4().hex[:12]
        folder = self.dir / rid
        folder.mkdir(parents=True)
        self.jobs[rid] = {"id": rid, "kind": kind, "status": "queued", "stage": "waiting", "progress": 0.0,
                          "error": None, "warnings": prompt_warnings(prompt), "created": time.time(),
                          "seconds": None, "comfy_job": None, "_folder": folder}
        return rid, folder

    async def start(self, layout_bytes, look_bytes, look_ext, prompt, width, height, frames, seed):
        check_dims(width, height, frames)
        rid, folder = self._new("render", prompt)
        self.jobs[rid].update(width=width, height=height, frames=frames)
        (folder / "layout.mp4").write_bytes(layout_bytes)
        (folder / f"look{look_ext}").write_bytes(look_bytes)
        self._spawn(rid, lambda on_progress: render(
            self.client, folder / "layout.mp4", folder / f"look{look_ext}", prompt, width=width, height=height,
            frames=frames, seed=seed, out=self.result_path(rid), on_progress=on_progress))
        return rid

    async def start_look(self, depth_bytes, prompt, width, height, seed, strength=1.0):
        look_size(width, height)  # validates the size
        rid, folder = self._new("look", prompt)
        (folder / "depth.png").write_bytes(depth_bytes)
        self._spawn(rid, lambda on_progress: render_look(
            self.client, folder / "depth.png", prompt, width=width, height=height, seed=seed, strength=strength,
            out=self.result_path(rid), on_progress=on_progress))
        return rid

    async def stitch(self, ids, clip="render"):
        """Cut finished renders (or the layout clips they were made from) together, in order."""
        if clip not in ("render", "layout"):
            raise ValueError('clip must be "render" or "layout"')
        if not 2 <= len(ids) <= self.MAX_SHOTS:
            raise ValueError(f"send 2 to {self.MAX_SHOTS} render ids")
        jobs = []
        for i in ids:
            job = self.jobs.get(i) if isinstance(i, str) else None
            if not job or job["kind"] != "render" or job["status"] != "succeeded":
                raise ValueError(f"{i!r} is not a finished render")
            jobs.append(job)
        if len({(j["width"], j["height"]) for j in jobs}) > 1:
            raise ValueError("all shots must have the same size")
        rid, folder = self._new("sequence", "sequence")
        job = self.jobs[rid]
        job.update(status="running", stage="joining", renders=list(ids), clip=clip,
                   frames=sum(j["frames"] for j in jobs), warnings=[])
        t0 = time.time()
        try:
            name = "render.mp4" if clip == "render" else "layout.mp4"
            await stitch([j["_folder"] / name for j in jobs], self.result_path(rid))
            job.update(status="succeeded", stage="done", progress=1.0)
        except (RuntimeError, OSError) as e:  # OSError: ffmpeg missing or not runnable
            job.update(status="failed", stage="failed", error=str(e))
        job["seconds"] = round(time.time() - t0, 1)
        self.prune()
        return rid

    async def cancel(self, rid):
        """Stop a job: ask Comfy to cancel it if it was submitted, and stop waiting for it here."""
        job = self.jobs[rid]
        if job["status"] not in ("queued", "running"):
            return False
        job["_cancelled"] = True
        handle = job.get("_comfy")
        if handle is not None:
            try:
                await handle.cancel()
            except Exception:  # noqa: BLE001 - a request, not a guarantee; we stop waiting either way
                pass
        task = job.get("_task")
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return True

    def _spawn(self, rid, run):
        self.jobs[rid]["_task"] = asyncio.get_running_loop().create_task(self._run(rid, run))

    async def _run(self, rid, run):
        job = self.jobs[rid]

        def on_progress(stage=None, progress=None, job_id=None, handle=None, **detail):
            if stage:
                job["stage"] = stage
            if progress is not None:
                job["progress"] = progress
            if job_id:
                job["comfy_job"] = job_id
            if handle is not None:
                job["_comfy"] = handle
            for key in ("node", "step", "steps"):  # what's running right now, for the status line
                if key in detail:
                    job[key] = detail[key]

        t0 = time.time()
        try:
            async with self.lock:
                job["status"] = "running"
                t0 = time.time()
                await run(on_progress)
                job.update(status="succeeded", stage="done", progress=1.0)
        except asyncio.CancelledError:
            if not job.get("_cancelled"):
                raise
            job.update(status="cancelled", stage="cancelled", error="cancelled")
        except Exception as e:  # noqa: BLE001 - anything (e.g. httpx.ConnectError from a restarting pod) ends the job
            if job.get("_cancelled"):
                job.update(status="cancelled", stage="cancelled", error="cancelled")
            else:
                if not isinstance(e, (ComfyError, RuntimeError, ValueError, OSError)):
                    log.exception("job %s failed", rid)
                job.update(status="failed", stage="failed", error=_describe(e))
        finally:
            job["seconds"] = round(time.time() - t0, 1)
            for key in ("node", "step", "steps"):
                job.pop(key, None)
            self.prune()


def _describe(e):
    err = getattr(e, "error", None)
    if isinstance(err, dict) and err.get("message"):
        node = f" (node {err.get('node_id')} {err.get('class_type') or ''})" if err.get("node_id") else ""
        return f"{err['message']}{node}"
    if err is not None and getattr(err, "message", None):
        return f"{err.message} (node {getattr(err, 'node_id', '?')})"
    return f"{type(e).__name__}: {e}"


async def health(request):
    client = request.app[SERVICE].client
    return web.json_response({"ok": True, "target": repr(client)})


async def _read_form(request):
    fields, files = {}, {}
    reader = await request.multipart()
    async for part in reader:
        if part.filename:
            files[part.name] = (part.filename, await part.read(decode=False))
        else:
            fields[part.name] = await part.text()
    return fields, files


async def create(request):
    svc = request.app[SERVICE]
    fields, files = await _read_form(request)
    try:
        if "layout" not in files or "look" not in files:
            raise ValueError("send both files: layout (mp4) and look (image)")
        look_ext = Path(files["look"][0]).suffix.lower()
        if look_ext not in IMAGE_TYPES:
            raise ValueError(f"look still must be one of {sorted(IMAGE_TYPES)}")
        if not files["layout"][1][4:8] == b"ftyp":
            raise ValueError("layout must be an MP4 file")
        rid = await svc.start(files["layout"][1], files["look"][1], look_ext, fields.get("prompt", ""),
                              int(fields.get("width", 0)), int(fields.get("height", 0)),
                              int(fields.get("frames", 0)), int(fields.get("seed") or 42))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response(svc.public(rid), status=202)


async def create_look(request):
    svc = request.app[SERVICE]
    fields, files = await _read_form(request)
    try:
        if "depth" not in files:
            raise ValueError("send the depth map of frame 0 as depth (png)")
        width, height = int(fields.get("width", 0)), int(fields.get("height", 0))
        if png_size(files["depth"][1]) != (width, height):
            raise ValueError(f"depth map must be {width}x{height} (the playblast size)")
        strength = float(fields.get("strength") or 1.0)
        if not 0.0 < strength <= 2.0:
            raise ValueError("strength must be in (0, 2]")
        rid = await svc.start_look(files["depth"][1], fields.get("prompt", ""), width, height,
                                   int(fields.get("seed") or 42), strength)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response(svc.public(rid), status=202)


async def create_sequence(request):
    svc = request.app[SERVICE]
    try:
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("renders"), list):
            raise ValueError('send JSON {"renders": [id, ...]}')
        rid = await svc.stitch(body["renders"], body.get("clip", "render"))
    except ValueError as e:  # also bad JSON
        return web.json_response({"error": str(e)}, status=400)
    out = svc.public(rid)
    return web.json_response(out, status=201 if out["status"] == "succeeded" else 500)


async def status(request):
    svc = request.app[SERVICE]
    rid = request.match_info["id"]
    if svc.jobs.get(rid, {}).get("kind") != request.match_info["kind"]:
        return web.json_response({"error": "unknown job"}, status=404)
    return web.json_response(svc.public(rid))


async def cancel(request):
    svc = request.app[SERVICE]
    rid = request.match_info["id"]
    if svc.jobs.get(rid, {}).get("kind") != request.match_info["kind"]:
        return web.json_response({"error": "unknown job"}, status=404)
    if not await svc.cancel(rid):
        return web.json_response({"error": f"job is already {svc.jobs[rid]['status']}", **svc.public(rid)}, status=409)
    return web.json_response(svc.public(rid))


async def result(request):
    svc = request.app[SERVICE]
    rid = request.match_info["id"]
    job = svc.jobs.get(rid)
    if not job or job["kind"] != request.match_info["kind"] or job["status"] != "succeeded":
        return web.json_response({"error": "no result yet"}, status=404)
    mime = "image/png" if job["kind"] == "look" else "video/mp4"
    return web.FileResponse(svc.result_path(rid), headers={"Content-Type": mime})


def check_origin(origin):
    """`https://host[:port]` -> itself (minus a trailing slash); anything that isn't a bare origin raises."""
    origin = origin.strip().rstrip("/")
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path or parts.query or parts.fragment:
        raise ValueError(f"--cors-origin must look like https://example.github.io, got {origin!r}")
    return origin


def cors_middleware(origins):
    """Let pages from `origins` (exact origins, no wildcard) call the API, including preflight requests."""
    origins = {origins} if isinstance(origins, str) else set(origins)

    @web.middleware
    async def cors(request, handler):
        origin = request.headers.get("Origin")
        if origin not in origins:
            resp = await handler(request)
            resp.headers.setdefault("Vary", "Origin")
            return resp
        if request.method == "OPTIONS" and "Access-Control-Request-Method" in request.headers:
            resp = web.Response(status=204, headers={
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers", ""),
                "Access-Control-Max-Age": "600",
            })
            # Chrome asks before a public page (GitHub Pages) may call a server on localhost / the LAN
            if request.headers.get("Access-Control-Request-Private-Network") == "true":
                resp.headers["Access-Control-Allow-Private-Network"] = "true"
        else:
            try:
                resp = await handler(request)
            except web.HTTPException as e:  # 404/405 from the router: still readable by the page
                e.headers.update({"Access-Control-Allow-Origin": origin, "Vary": "Origin"})
                raise
            except Exception as e:  # noqa: BLE001 - a bug in a handler: the page should see it, not "Failed to fetch"
                log.exception("%s %s failed", request.method, request.path)
                resp = web.json_response({"error": f"server error: {type(e).__name__}: {e}"}, status=500)
        resp.headers.update({"Access-Control-Allow-Origin": origin, "Vary": "Origin"})
        return resp

    return cors


def make_app(client, renders_dir=RENDERS, cors_origin=None, keep_jobs=KEEP_JOBS):
    """`cors_origin`: one origin or a list of them (None: same origin only)."""
    origins = [cors_origin] if isinstance(cors_origin, str) else list(cors_origin or [])
    middlewares = [cors_middleware([check_origin(o) for o in origins])] if origins else []
    app = web.Application(client_max_size=MAX_UPLOAD, middlewares=middlewares)
    app[SERVICE] = RenderService(client, renders_dir, keep_jobs)
    app.add_routes([
        web.get("/api/health", health),
        web.post("/api/render", create),
        web.post("/api/look", create_look),
        web.post("/api/stitch", create_sequence),
        web.post(r"/api/{kind:render|look}/{id}/cancel", cancel),
        web.get(r"/api/{kind:render|look|sequence}/{id}", status),
        web.get(r"/api/{kind:render|sequence}/{id}/video", result),
        web.get(r"/api/{kind:look}/{id}/image", result),
    ])
    return app


def main():
    ap = argparse.ArgumentParser(description="Open Cinema Studio render server (Comfy SDK)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8190)))
    ap.add_argument("--host", default="127.0.0.1", help="interface to listen on (0.0.0.0 on a pod)")
    ap.add_argument("--comfy-url", help="sets COMFY_BASE_URL (default: Comfy Cloud, or the env var)")
    ap.add_argument("--cors-origin", action="append",
                    help="let a page on this origin call the server, e.g. https://colinwww.github.io (repeatable)")
    ap.add_argument("--keep-jobs", type=int, default=KEEP_JOBS,
                    help=f"finished jobs (and server/renders/<id>/ folders) to keep, newest first; 0 keeps all "
                         f"(default {KEEP_JOBS})")
    args = ap.parse_args()
    if args.keep_jobs < 0:
        ap.error("--keep-jobs must be 0 or more")
    if args.cors_origin:
        try:
            args.cors_origin = [check_origin(o) for o in args.cors_origin]
        except ValueError as e:
            ap.error(str(e))
    if args.comfy_url:
        os.environ["COMFY_BASE_URL"] = args.comfy_url

    async def app_factory():
        client = tolerate_head_rewrites(AsyncComfy(timeout=120.0))
        app = make_app(client, cors_origin=args.cors_origin, keep_jobs=args.keep_jobs)
        app.on_cleanup.append(lambda _: client.aclose())
        cors = f" (CORS: {', '.join(args.cors_origin)})" if args.cors_origin else ""
        print(f"render server on http://{args.host}:{args.port} -> {client!r}{cors}")
        return app

    web.run_app(app_factory(), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
