"""Cutting shots together: server.stitch and POST /api/stitch (no GPU, no ComfyUI)."""

import shutil
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from server.app import SERVICE, make_app
from server.stitch import concat_list

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = ROOT / "examples" / "layout_plaza_dolly_in.mp4"
RENDER = ROOT / "examples" / "stage1_genlook_plaza_a40.mp4"


class ConcatListTest(unittest.TestCase):
    def test_absolute_paths_and_quotes(self):
        text = concat_list(["a.mp4", "/tmp/it's.mp4"])
        lines = text.splitlines()
        self.assertEqual(lines[0], "ffconcat version 1.0")
        self.assertTrue(lines[1].startswith("file '/") and lines[1].endswith("/a.mp4'"))
        self.assertEqual(lines[2], "file '/tmp/it'\\''s.mp4'")


@unittest.skipUnless(LAYOUT.is_file() and RENDER.is_file(), "example clips missing")
class StitchApiTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ocs-stitch-"))
        self.app = make_app(object(), renders_dir=self.tmp)
        self.svc = self.app[SERVICE]
        self.http = TestClient(TestServer(self.app))
        await self.http.start_server()

    async def asyncTearDown(self):
        await self.http.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def finished_render(self, width=960, height=576, frames=65, status="succeeded"):
        """A render job as the service leaves it, with real clips in its folder."""
        rid, folder = self.svc._new("render", "a plaza")
        shutil.copy(LAYOUT, folder / "layout.mp4")
        shutil.copy(RENDER, folder / "render.mp4")
        self.svc.jobs[rid].update(status=status, width=width, height=height, frames=frames, seconds=1.0)
        return rid

    async def test_joins_renders_in_order(self):
        ids = [self.finished_render() for _ in range(3)]
        res = await self.http.post("/api/stitch", json={"renders": ids})
        self.assertEqual(res.status, 201)
        seq = await res.json()
        self.assertEqual((seq["kind"], seq["status"], seq["frames"], seq["renders"]), ("sequence", "succeeded", 195, ids))
        video = await self.http.get(seq["video_url"])
        self.assertEqual(video.status, 200)
        self.assertEqual(video.headers["Content-Type"], "video/mp4")
        data = await video.read()
        self.assertEqual(data[4:8], b"ftyp")
        self.assertGreater(len(data), 2.5 * RENDER.stat().st_size)
        status = await (await self.http.get(f"/api/sequence/{seq['id']}")).json()
        self.assertEqual(status["status"], "succeeded")

    async def test_joins_the_layout_clips_too(self):
        ids = [self.finished_render() for _ in range(2)]
        seq = await (await self.http.post("/api/stitch", json={"renders": ids, "clip": "layout"})).json()
        self.assertEqual(seq["status"], "succeeded")
        size = len(await (await self.http.get(seq["video_url"])).read())
        self.assertLess(size, 3 * LAYOUT.stat().st_size)  # the grey clips, not the renders

    async def test_rejects_bad_requests(self):
        ok = self.finished_render()
        running = self.finished_render(status="running")
        other_size = self.finished_render(width=1920, height=1088)
        look, _ = self.svc._new("look", "x")
        cases = [
            ({"renders": [ok]}, "2 to"),
            ({"renders": [ok, "nope"]}, "not a finished render"),
            ({"renders": [ok, running]}, "not a finished render"),
            ({"renders": [ok, look]}, "not a finished render"),
            ({"renders": [ok, other_size]}, "same size"),
            ({"renders": [ok, ok], "clip": "depth"}, "clip must be"),
            ({"renders": "abc"}, "send JSON"),
            ([ok, ok], "send JSON"),
        ]
        for body, message in cases:
            res = await self.http.post("/api/stitch", json=body)
            self.assertEqual(res.status, 400, body)
            self.assertIn(message, (await res.json())["error"])
        res = await self.http.post("/api/stitch", data=b"not json", headers={"Content-Type": "application/json"})
        self.assertEqual(res.status, 400)

    async def test_ffmpeg_failure_is_reported(self):
        ids = [self.finished_render() for _ in range(2)]
        (self.svc.jobs[ids[1]]["_folder"] / "render.mp4").write_bytes(b"not a video")
        res = await self.http.post("/api/stitch", json={"renders": ids})
        self.assertEqual(res.status, 500)
        body = await res.json()
        self.assertEqual(body["status"], "failed")
        self.assertIn("ffmpeg", body["error"])


if __name__ == "__main__":
    unittest.main()
