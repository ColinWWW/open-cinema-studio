"""RenderService.public reports elapsed time on the server's clock."""

import tempfile
import time
import unittest

from server.app import RenderService


class ElapsedTest(unittest.TestCase):
    def test_public_adds_elapsed_from_the_server_clock(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = RenderService(object(), tmp)
            rid, _ = svc._new("render", "a plaza")
            svc.jobs[rid]["created"] = time.time() - 42
            out = svc.public(rid)
            self.assertAlmostEqual(out["elapsed"], 42, delta=1)
            self.assertNotIn("_folder", out)


if __name__ == "__main__":
    unittest.main()
