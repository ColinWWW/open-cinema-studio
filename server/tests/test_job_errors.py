"""A job ends (failed) whatever its run raises, so the page never polls a stuck "running" job (no ComfyUI)."""

import asyncio
import tempfile
import unittest
from unittest import mock

import httpx

from server.app import RenderService


class JobErrorTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.svc = RenderService(object(), self.tmp.name)

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def run_job(self, exc):
        rid, _ = self.svc._new("render", "a plaza")

        async def run(on_progress):
            on_progress(stage="uploading")
            raise exc

        self.svc._spawn(rid, run)
        await asyncio.wait_for(self.svc.jobs[rid]["_task"], 5)
        return self.svc.public(rid)

    async def test_connection_error_fails_the_job(self):
        with self.assertLogs("server.app", "ERROR"):  # unexpected kinds get a traceback in the server log
            state = await self.run_job(httpx.ConnectError("pod down"))
        self.assertEqual((state["status"], state["stage"]), ("failed", "failed"))
        self.assertIn("ConnectError: pod down", state["error"])
        self.assertIsNotNone(state["seconds"])

    async def test_any_exception_fails_the_job(self):
        with self.assertLogs("server.app", "ERROR"):
            state = await self.run_job(KeyError("outputs"))
        self.assertEqual(state["status"], "failed")

    async def test_expected_errors_fail_quietly(self):
        state = await self.run_job(RuntimeError("no video from node 60"))
        self.assertEqual((state["status"], state["error"]), ("failed", "RuntimeError: no video from node 60"))

    async def test_stitch_without_ffmpeg_fails_the_sequence(self):
        for rid in ("a", "b"):
            folder = self.svc.dir / rid
            folder.mkdir()
            self.svc.jobs[rid] = {"id": rid, "kind": "render", "status": "succeeded", "width": 960, "height": 576,
                                  "frames": 65, "_folder": folder}
        with mock.patch("server.app.stitch", side_effect=FileNotFoundError("ffmpeg")):
            sid = await self.svc.stitch(["a", "b"])
        self.assertEqual(self.svc.jobs[sid]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
