"""--cors-origin: CORS headers and preflight answers for one origin only (no GPU, no ComfyUI)."""

import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

from server.app import check_origin, make_app

PAGES = "https://colinwww.github.io"


class FakeComfy:
    def __repr__(self):
        return "FakeComfy()"


class BrokenComfy:
    def __repr__(self):
        raise RuntimeError("boom")


class CheckOriginTest(unittest.TestCase):
    def test_bare_origins(self):
        self.assertEqual(check_origin(PAGES), PAGES)
        self.assertEqual(check_origin(" https://colinwww.github.io/ "), PAGES)
        self.assertEqual(check_origin("http://localhost:5173"), "http://localhost:5173")

    def test_rejects_paths_and_wildcards(self):
        for bad in ("*", "colinwww.github.io", "https://colinwww.github.io/open-cinema-studio/", "ftp://x.io", ""):
            with self.assertRaises(ValueError, msg=bad):
                check_origin(bad)


class CorsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.http = TestClient(TestServer(make_app(FakeComfy(), renders_dir=self.tmp.name, cors_origin=PAGES + "/")))
        await self.http.start_server()

    async def asyncTearDown(self):
        await self.http.close()
        self.tmp.cleanup()

    async def test_allowed_origin_gets_headers(self):
        res = await self.http.get("/api/health", headers={"Origin": PAGES})
        self.assertEqual(res.status, 200)
        self.assertEqual(res.headers["Access-Control-Allow-Origin"], PAGES)
        self.assertIn("Origin", res.headers["Vary"])
        self.assertEqual((await res.json())["target"], "FakeComfy()")

    async def test_errors_are_readable_cross_origin(self):
        res = await self.http.get("/api/render/nope", headers={"Origin": PAGES})
        self.assertEqual(res.status, 404)
        self.assertEqual(res.headers["Access-Control-Allow-Origin"], PAGES)
        res = await self.http.get("/api/unknown", headers={"Origin": PAGES})  # router 404
        self.assertEqual(res.status, 404)
        self.assertEqual(res.headers["Access-Control-Allow-Origin"], PAGES)

    async def test_preflight(self):
        res = await self.http.options("/api/render", headers={
            "Origin": PAGES, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
        })
        self.assertEqual(res.status, 204)
        self.assertEqual(res.headers["Access-Control-Allow-Origin"], PAGES)
        self.assertIn("POST", res.headers["Access-Control-Allow-Methods"])
        self.assertEqual(res.headers["Access-Control-Allow-Headers"], "content-type")
        self.assertEqual(res.headers["Access-Control-Allow-Private-Network"], "true")

    async def test_other_origins_get_nothing(self):
        evil = {"Origin": "https://evil.example"}
        res = await self.http.get("/api/health", headers=evil)
        self.assertNotIn("Access-Control-Allow-Origin", res.headers)
        res = await self.http.options("/api/render", headers={**evil, "Access-Control-Request-Method": "POST"})
        self.assertNotIn("Access-Control-Allow-Origin", res.headers)
        self.assertGreaterEqual(res.status, 400)

    async def test_same_origin_unchanged(self):
        res = await self.http.get("/api/health")
        self.assertEqual(res.status, 200)
        self.assertNotIn("Access-Control-Allow-Origin", res.headers)


class UnexpectedErrorTest(unittest.IsolatedAsyncioTestCase):
    async def test_handler_bug_is_a_readable_json_500(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = make_app(BrokenComfy(), renders_dir=tmp, cors_origin=PAGES)
            async with TestClient(TestServer(app)) as http:
                with self.assertLogs("server.app", "ERROR") as logs:
                    res = await http.get("/api/health", headers={"Origin": PAGES})
                self.assertEqual(res.status, 500)
                self.assertEqual(res.headers["Access-Control-Allow-Origin"], PAGES)
                self.assertEqual(await res.json(), {"error": "server error: RuntimeError: boom"})
                self.assertIn("Traceback", logs.output[0])


class NoCorsTest(unittest.IsolatedAsyncioTestCase):
    async def test_off_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            async with TestClient(TestServer(make_app(FakeComfy(), renders_dir=tmp))) as http:
                res = await http.get("/api/health", headers={"Origin": PAGES})
                self.assertNotIn("Access-Control-Allow-Origin", res.headers)
                res = await http.options("/api/render", headers={"Origin": PAGES, "Access-Control-Request-Method": "POST"})
                self.assertNotIn("Access-Control-Allow-Origin", res.headers)


if __name__ == "__main__":
    unittest.main()
