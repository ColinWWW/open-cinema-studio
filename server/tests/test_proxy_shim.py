import os
import unittest
from unittest import mock

import httpx
from comfy_low.errors import ApiError
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

    async def test_dedup_check_sends_one_head(self):
        with mock.patch.dict(os.environ, {"COMFY_BASE_URL": "https://pod-8189.proxy.runpod.net"}):
            async with AsyncComfy(api_key="t") as c:
                low = tolerate_head_rewrites(c)._low
                for code, expected in ((200, True), (404, False), (405, False)):
                    request = httpx.Request("HEAD", "https://pod-8189.proxy.runpod.net/api/v2/assets/by-hash/x")
                    with mock.patch.object(low, "raw_request", mock.AsyncMock(
                            return_value=httpx.Response(code, request=request))) as raw:
                        self.assertIs(await low.head_asset_by_hash("blake3:abc"), expected, code)
                        raw.assert_awaited_once_with("HEAD", "/assets/by-hash/blake3:abc")
                request = httpx.Request("HEAD", "https://pod-8189.proxy.runpod.net/api/v2/assets/by-hash/x")
                with mock.patch.object(low, "raw_request", mock.AsyncMock(
                        return_value=httpx.Response(500, request=request))) as raw:
                    with self.assertRaises(ApiError):  # as the SDK's own check; commit() makes it a ComfyError
                        await low.head_asset_by_hash("blake3:abc")
                    raw.assert_awaited_once()

    def test_unknown_sdk_internals_fail_loudly(self):
        with self.assertRaisesRegex(RuntimeError, "comfy-sdk 0.5.x"):
            tolerate_head_rewrites(object())


if __name__ == "__main__":
    unittest.main()
