"""--keep-jobs: old finished jobs and their server/renders/<id>/ folders are pruned (no ComfyUI)."""

import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path

from server.app import RenderService


class PruneTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.svc = RenderService(object(), self.tmp.name, keep_jobs=3)

    async def asyncTearDown(self):
        self.tmp.cleanup()

    def job(self, status, kind="render", **extra):
        rid, folder = self.svc._new(kind, "a plaza")
        (folder / "render.mp4").write_bytes(b"x")
        self.svc.jobs[rid].update(status=status, **extra)
        return rid

    def test_keeps_the_newest_finished_jobs(self):
        old = [self.job(s) for s in ("succeeded", "failed", "cancelled")]
        new = [self.job("succeeded") for _ in range(3)]
        self.svc.prune()
        self.assertEqual(set(self.svc.jobs), set(new))
        for rid in old:
            self.assertFalse((Path(self.tmp.name) / rid).exists())
        for rid in new:
            self.assertTrue((Path(self.tmp.name) / rid / "render.mp4").exists())

    def test_never_prunes_queued_or_running(self):
        busy = [self.job("queued"), self.job("running")]
        done = [self.job("succeeded") for _ in range(5)]
        self.svc.prune()
        self.assertEqual(set(self.svc.jobs), {*busy, *done[2:]})

    def test_keeps_renders_a_sequence_needs(self):
        shots = [self.job("succeeded") for _ in range(2)]
        seq = self.job("succeeded", kind="sequence", renders=shots)
        later = [self.job("succeeded") for _ in range(3)]
        self.svc.prune()  # the sequence goes (oldest unneeded), then its shots are free to go too
        self.assertEqual(set(self.svc.jobs), set(later))
        shots = [self.job("succeeded") for _ in range(2)]
        seq = self.job("succeeded", kind="sequence", renders=shots)
        self.svc.keep_jobs = 1
        self.svc.jobs[seq]["created"] = 0  # a sequence older than everything: it goes first
        self.svc.prune()
        self.assertEqual(set(self.svc.jobs), {shots[1]})
        self.svc.keep_jobs = 2
        shots = [self.job("succeeded") for _ in range(2)]
        seq = self.job("running", kind="sequence", renders=shots)  # still cutting them together
        self.svc.prune()
        self.assertTrue({*shots, seq} <= set(self.svc.jobs))

    def test_zero_keeps_everything(self):
        self.svc.keep_jobs = 0
        rids = [self.job("succeeded") for _ in range(5)]
        self.svc.prune()
        self.assertEqual(set(self.svc.jobs), set(rids))

    async def test_finished_jobs_prune_themselves(self):
        rids = [self.job("succeeded") for _ in range(3)]
        rid, _ = self.svc._new("render", "a plaza")

        async def run(on_progress):
            await asyncio.sleep(0)

        self.svc._spawn(rid, run)
        await self.svc.jobs[rid]["_task"]
        self.assertEqual(set(self.svc.jobs), {*rids[1:], rid})

    def test_old_folders_from_an_earlier_run(self):
        root = Path(self.tmp.name)
        names = [f"{i:012x}" for i in range(5)]
        now = time.time()
        for i, name in enumerate(names):
            (root / name).mkdir()
            os.utime(root / name, (now - 100 + i, now - 100 + i))
        (root / "keep-me").mkdir()  # not a job folder
        RenderService(object(), root, keep_jobs=2)
        self.assertEqual({d.name for d in root.iterdir()}, {*names[3:], "keep-me"})


if __name__ == "__main__":
    unittest.main()
