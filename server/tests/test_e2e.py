"""Full chain without a GPU: SDK -> comfy-api-proxy -> mock ComfyUI, and the HTTP app on top."""

import asyncio
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer
from comfy_sdk import AsyncComfy, JobFailed

from server.app import make_app
from server.mock_comfyui import MockComfy
from server.render import png_size, render, render_look
from server.tests.pngs import gray_png

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = ROOT / "examples" / "layout_plaza_dolly_in.mp4"
LOOK = ROOT / "examples" / "look_plaza_960x576.png"
PROMPT = "A sunny stone plaza with a lamp post, wooden crates and a kiosk, slow push-in."


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(LAYOUT.is_file() and LOOK.is_file(), "example layout/look files missing")
class EndToEndTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="ocs-e2e-"))
        cls.comfy_port, cls.proxy_port = free_port(), free_port()
        # mock ComfyUI in its own process, so it keeps serving between test event loops
        cls.mock = subprocess.Popen([sys.executable, "-m", "server.mock_comfyui", "--port", str(cls.comfy_port),
                                     "--delay", "0.5"], cwd=ROOT)
        cls.proxy = subprocess.Popen([sys.executable, "-c", "from comfy_api_proxy.cli import main; main()",
                                      "--comfyui", f"http://127.0.0.1:{cls.comfy_port}",
                                      "--port", str(cls.proxy_port)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for url in (f"http://127.0.0.1:{cls.comfy_port}/queue", f"http://127.0.0.1:{cls.proxy_port}/api/v2/health"):
            for _ in range(100):
                try:
                    urllib.request.urlopen(url, timeout=1)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError(f"{url} never came up")
        os.environ["COMFY_BASE_URL"] = f"http://127.0.0.1:{cls.proxy_port}"
        cls.depth = cls.tmp / "depth.png"
        cls.depth.write_bytes(gray_png(960, 576, value=90))

    @classmethod
    def tearDownClass(cls):
        for p in (cls.proxy, cls.mock):
            p.terminate()
            p.wait(10)
        os.environ.pop("COMFY_BASE_URL", None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    async def test_render_through_sdk(self):
        seen = []
        async with AsyncComfy() as client:
            data, job_id = await render(client, LAYOUT, LOOK, PROMPT, width=960, height=576, frames=65,
                                        out=self.tmp / "out.mp4", on_progress=lambda **kw: seen.append(kw))
        # the mock "renders" by returning the uploaded layout, so this proves upload + download round-trip
        self.assertEqual(data, LAYOUT.read_bytes())
        self.assertEqual((self.tmp / "out.mp4").read_bytes(), data)
        self.assertTrue(job_id)
        self.assertIn("queued", [s.get("stage") for s in seen])

    async def test_node_error_surfaces(self):
        async with AsyncComfy() as client:
            with self.assertRaises(JobFailed) as cm:
                await render(client, LAYOUT, LOOK, "MOCK_FAIL " + PROMPT, width=960, height=576, frames=65)
        self.assertIn("mock failure", cm.exception.error.message)

    async def test_look_through_sdk(self):
        async with AsyncComfy() as client:
            data, job_id = await render_look(client, self.depth, PROMPT, width=960, height=576, seed=3,
                                             out=self.tmp / "look.png")
        # the mock returns the uploaded depth map as the "still"
        self.assertEqual(data, self.depth.read_bytes())
        self.assertEqual(png_size(data), (960, 576))
        self.assertEqual((self.tmp / "look.png").read_bytes(), data)
        self.assertTrue(job_id)

    async def test_http_look_then_render(self):
        """The web panel's chain: depth -> look still -> render with that still."""
        async with AsyncComfy() as comfy:
            async with TestClient(TestServer(make_app(comfy, renders_dir=self.tmp / "renders"))) as http:
                async def finish(kind, rid):
                    for _ in range(200):
                        state = await (await http.get(f"/api/{kind}/{rid}")).json()
                        if state["status"] in ("succeeded", "failed"):
                            return state
                        await asyncio.sleep(0.1)
                    self.fail(f"{kind} {rid} never finished")

                form = FormData()
                form.add_field("depth", self.depth.read_bytes(), filename="depth.png", content_type="image/png")
                for k, v in {"prompt": PROMPT, "width": "960", "height": "576", "seed": "5", "strength": "0.9"}.items():
                    form.add_field(k, v)
                r = await http.post("/api/look", data=form)
                self.assertEqual(r.status, 202, await r.text())
                look_id = (await r.json())["id"]
                state = await finish("look", look_id)
                self.assertEqual(state["status"], "succeeded", state)
                self.assertEqual(state["kind"], "look")
                self.assertEqual((await http.get(f"/api/render/{look_id}")).status, 404)  # kinds don't mix
                r = await http.get(state["image_url"])
                self.assertEqual(r.headers["Content-Type"], "image/png")
                still = await r.read()
                self.assertEqual(png_size(still), (960, 576))

                form = FormData()
                form.add_field("layout", LAYOUT.read_bytes(), filename="layout.mp4", content_type="video/mp4")
                form.add_field("look", still, filename="look.png", content_type="image/png")
                for k, v in {"prompt": PROMPT, "width": "960", "height": "576", "frames": "65"}.items():
                    form.add_field(k, v)
                r = await http.post("/api/render", data=form)
                self.assertEqual(r.status, 202, await r.text())
                state = await finish("render", (await r.json())["id"])
                self.assertEqual(state["status"], "succeeded", state)

                for bad_fields, msg in [({"width": "640", "height": "384"}, "must be 640x384"),
                                        ({"width": "960", "height": "576", "prompt": " "}, "prompt is empty"),
                                        ({"width": "960", "height": "576", "strength": "5"}, "strength")]:
                    bad = FormData()
                    bad.add_field("depth", self.depth.read_bytes(), filename="depth.png")
                    for k, v in {"prompt": PROMPT, **bad_fields}.items():
                        bad.add_field(k, v)
                    r = await http.post("/api/look", data=bad)
                    self.assertEqual(r.status, 400)
                    self.assertIn(msg, (await r.json())["error"])

    async def test_http_app(self):
        async with AsyncComfy() as comfy:
            async with TestClient(TestServer(make_app(comfy, renders_dir=self.tmp / "renders"))) as http:
                r = await http.get("/api/health")
                self.assertIn(str(self.proxy_port), (await r.json())["target"])

                form = FormData()
                form.add_field("layout", LAYOUT.read_bytes(), filename="layout.mp4", content_type="video/mp4")
                form.add_field("look", LOOK.read_bytes(), filename="look.png", content_type="image/png")
                for k, v in {"prompt": PROMPT, "width": "960", "height": "576", "frames": "65"}.items():
                    form.add_field(k, v)
                r = await http.post("/api/render", data=form)
                self.assertEqual(r.status, 202, await r.text())
                rid = (await r.json())["id"]
                for _ in range(200):
                    state = await (await http.get(f"/api/render/{rid}")).json()
                    if state["status"] in ("succeeded", "failed"):
                        break
                    await asyncio.sleep(0.1)
                self.assertEqual(state["status"], "succeeded", state)
                r = await http.get(state["video_url"])
                self.assertEqual(r.headers["Content-Type"], "video/mp4")
                self.assertEqual(await r.read(), LAYOUT.read_bytes())

                bad = FormData()
                bad.add_field("layout", LAYOUT.read_bytes(), filename="layout.mp4")
                bad.add_field("look", LOOK.read_bytes(), filename="look.png")
                bad.add_field("prompt", PROMPT)
                for k, v in {"width": "1000", "height": "576", "frames": "65"}.items():
                    bad.add_field(k, v)
                r = await http.post("/api/render", data=bad)
                self.assertEqual(r.status, 400)
                self.assertIn("divisible by 64", (await r.json())["error"])


if __name__ == "__main__":
    unittest.main()
