"""Cancelling jobs: RenderService.cancel and POST /api/{kind}/{id}/cancel (no ComfyUI)."""

import asyncio
import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

from server.app import SERVICE, make_app


class FakeHandle:
    def __init__(self):
        self.cancelled = False

    async def cancel(self):
        self.cancelled = True


class CancelTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.http = TestClient(TestServer(make_app(object(), renders_dir=self.tmp.name)))
        await self.http.start_server()
        self.svc = self.http.app[SERVICE]

    async def asyncTearDown(self):
        await self.http.close()
        self.tmp.cleanup()

    def spawn(self, handle, started):
        rid, _ = self.svc._new("render", "a plaza")

        async def run(on_progress):
            on_progress(stage="queued", job_id="comfy-1", handle=handle)
            on_progress(stage="rendering", progress=0.4, node="Sample stage 1", step=3, steps=8)
            started.set()
            await asyncio.sleep(60)

        self.svc._spawn(rid, run)
        return rid

    async def test_running_job_is_cancelled_in_comfy_too(self):
        handle, started = FakeHandle(), asyncio.Event()
        rid = self.spawn(handle, started)
        await started.wait()
        state = await (await self.http.get(f"/api/render/{rid}")).json()
        self.assertEqual((state["node"], state["step"], state["steps"]), ("Sample stage 1", 3, 8))
        self.assertNotIn("_comfy", state)
        resp = await self.http.post(f"/api/render/{rid}/cancel")
        self.assertEqual(resp.status, 200)
        state = await resp.json()
        self.assertEqual((state["status"], state["error"]), ("cancelled", "cancelled"))
        self.assertNotIn("node", state)
        self.assertTrue(handle.cancelled)
        # a second cancel: already over
        self.assertEqual((await self.http.post(f"/api/render/{rid}/cancel")).status, 409)

    async def test_queued_job_never_runs(self):
        first, second = asyncio.Event(), asyncio.Event()
        a = self.spawn(FakeHandle(), first)
        b = self.spawn(FakeHandle(), second)  # waits for the GPU behind a
        await first.wait()
        self.assertEqual((await (await self.http.post(f"/api/render/{b}/cancel")).json())["status"], "cancelled")
        self.assertFalse(second.is_set())
        await self.svc.cancel(a)

    async def test_unknown_or_wrong_kind(self):
        self.assertEqual((await self.http.post("/api/render/nope/cancel")).status, 404)
        rid = self.spawn(FakeHandle(), asyncio.Event())
        self.assertEqual((await self.http.post(f"/api/look/{rid}/cancel")).status, 404)
        await self.svc.cancel(rid)


if __name__ == "__main__":
    unittest.main()
