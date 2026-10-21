import os
import unittest
from unittest import mock

from comfy_sdk import AsyncComfy

from server.render import tolerate_head_rewrites


class ProxyShimTest(unittest.IsolatedAsyncioTestCase):
    async def test_rewrites_internal_links_to_base_url(self):
        with mock.patch.dict(os.environ, {"COMFY_BASE_URL": "https://pod-8189.proxy.runpod.net"}):
            async with AsyncComfy(api_key="t") as c:
                prep = tolerate_head_rewrites(c)._low._p
                url = prep.url("http://100.65.21.69:60277/api/v2/jobs/abc?x=1")
                self.assertEqual(url, "https://pod-8189.proxy.runpod.net/api/v2/jobs/abc?x=1")
                self.assertIn("Authorization", prep.headers(url))  # same origin again, so the token goes along
                self.assertEqual(prep.url("https://elsewhere.example/file.mp4"), "https://elsewhere.example/file.mp4")
                self.assertEqual(prep.url("/jobs/abc"), "https://pod-8189.proxy.runpod.net/api/v2/jobs/abc")


if __name__ == "__main__":
    unittest.main()
