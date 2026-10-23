"""server.local: finding ComfyUI and the commands it starts (no GPU, nothing launched)."""

import sys
import tempfile
import unittest
from pathlib import Path

from server.local import ORIGINS, comfyui_command, find_comfyui, server_command, venv_python


class LocalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_find_comfyui(self):
        (self.dir / "main.py").write_text("")
        self.assertEqual(find_comfyui(str(self.dir), env={}), self.dir)
        self.assertEqual(find_comfyui(None, env={"COMFY_DIR": str(self.dir)}), self.dir)

    def test_venv_python(self):
        self.assertEqual(venv_python(self.dir), sys.executable)
        exe = self.dir / ".venv" / "Scripts" / "python.exe"
        exe.parent.mkdir(parents=True)
        exe.write_text("")
        self.assertEqual(venv_python(self.dir), str(exe))

    def test_comfyui_command(self):
        cmd = comfyui_command(self.dir, "py", 8188, lowvram=False)
        self.assertEqual(cmd[1:], [str(self.dir / "main.py"), "--listen", "127.0.0.1", "--port", "8188"])
        self.assertEqual(comfyui_command(self.dir, "py", 8188, lowvram=True)[-1], "--lowvram")

    def test_server_command_lets_the_live_page_and_dev_server_in(self):
        cmd = server_command(8189, 8190, ORIGINS)
        self.assertEqual(cmd[1:7], ["-m", "server.app", "--comfy-url", "http://127.0.0.1:8189", "--port", "8190"])
        origins = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--cors-origin"]
        self.assertIn("https://colinwww.github.io", origins)
        self.assertIn("http://localhost:5173", origins)
        self.assertNotIn("--host", cmd)  # this machine only, unless asked
        self.assertEqual(server_command(8189, 8190, ORIGINS, "0.0.0.0")[-2:], ["--host", "0.0.0.0"])


if __name__ == "__main__":
    unittest.main()
