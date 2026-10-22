"""Render on this computer: start ComfyUI, comfy-api-proxy and the render server together, then pick
**This computer** in the app's Render panel.

    python -m server.local                                   # ComfyUI from ./ComfyUI (scripts/setup_local.*)
    python -m server.local --comfyui-dir D:\\ComfyUI          # a ComfyUI checkout somewhere else
    python -m server.local --comfyui-url http://127.0.0.1:8188   # a ComfyUI you already run
    python -m server.local --mock                            # no GPU: the stand-in ComfyUI, to try the panel

It checks the GPU first (server.doctor): under 24 GB of VRAM ComfyUI runs with --lowvram, and under 16 GB a
video render won't fit (look stills still run). Ctrl+C stops everything it started. Logs go to server/logs/.
"""

import argparse
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import doctor
from .workflow import WORKFLOW_FILES

REPO = Path(__file__).resolve().parent.parent
LOGS = Path(__file__).resolve().parent / "logs"
# Pages that may call the render server: the live page and the Vite dev and preview servers.
ORIGINS = ["https://colinwww.github.io", "http://localhost:5173", "http://127.0.0.1:5173",
           "http://localhost:4173", "http://127.0.0.1:4173"]


def find_comfyui(given=None, env=os.environ):
    """The ComfyUI checkout to run: --comfyui-dir, then $COMFY_DIR, then ./ComfyUI. None if there's none."""
    for d in (given, env.get("COMFY_DIR"), REPO / "ComfyUI"):
        if d and (Path(d) / "main.py").is_file():
            return Path(d)
    return None


def venv_python(comfy_dir):
    """ComfyUI's own venv Python if it has one (Windows or POSIX layout), else this Python."""
    for rel in (".venv/Scripts/python.exe", ".venv/bin/python", "venv/Scripts/python.exe", "venv/bin/python"):
        if (comfy_dir / rel).is_file():
            return str(comfy_dir / rel)
    return sys.executable


def comfyui_command(comfy_dir, python, port, lowvram):
    cmd = [python, str(comfy_dir / "main.py"), "--listen", "127.0.0.1", "--port", str(port)]
    return cmd + ["--lowvram"] if lowvram else cmd


def server_command(proxy_port, port, origins):
    cmd = [sys.executable, "-m", "server.app", "--comfy-url", f"http://127.0.0.1:{proxy_port}", "--port", str(port)]
    for o in origins:
        cmd += ["--cors-origin", o]
    return cmd


def answers(url, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500
    except (urllib.error.URLError, OSError):
        return False


class Stack:
    """The processes this run started, stopped in reverse order on exit."""

    def __init__(self):
        self.procs = []

    def start(self, name, cmd, cwd=REPO):
        LOGS.mkdir(exist_ok=True)
        log = open(LOGS / f"{name}.log", "w", encoding="utf-8")  # noqa: SIM115 - closed with the process
        print(f"  starting {name}: {' '.join(cmd)}")
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        self.procs.append((name, proc, log))
        return proc

    def wait_for(self, name, proc, url, seconds):
        """Wait until `url` answers; fail early if the process dies."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if answers(url):
                return
            if proc.poll() is not None:
                raise SystemExit(f"{name} stopped (exit {proc.returncode}). Last lines of {LOGS / (name + '.log')}:\n"
                                 + tail(LOGS / f"{name}.log"))
            time.sleep(1)
        raise SystemExit(f"{name} didn't answer {url} within {seconds}s; see {LOGS / (name + '.log')}")

    def stop(self):
        for name, proc, log in reversed(self.procs):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
            log.close()
            print(f"  stopped {name}")


def tail(path, lines=15):
    try:
        return "\n".join(Path(path).read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return "(no log)"


def check_hardware(force):
    """Print the GPU and RAM checks; returns whether ComfyUI should use --lowvram. Exits with no GPU (unless forced)."""
    found = doctor.gpus()
    for ok, msg in doctor.hardware_checks(found, doctor.ram_gb()):
        print(("ok   " if ok else "WARN ") + msg)
    if not found:
        if not force:
            raise SystemExit("No NVIDIA GPU: nothing to render on here. Try --mock to see the panel work, or render "
                             "on a pod or Comfy Cloud. (--force starts ComfyUI anyway.)")
        return True
    return doctor.lowvram(max(v for _, v in found))


def check_models(comfy_url):
    """Warn (don't stop) about nodes or model files our workflows need that ComfyUI doesn't have."""
    try:
        problems = doctor.check_graphs(doctor.fetch_object_info(comfy_url),
                                       {name: build() for name, build in WORKFLOW_FILES.items()})
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"WARN couldn't ask ComfyUI for its nodes and models ({e})")
        return
    for p in problems:
        print("WARN " + p)
    if not problems:
        print("ok   ComfyUI has every node and model file the workflows use")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--comfyui-dir", help="your ComfyUI checkout (default: $COMFY_DIR, then ./ComfyUI)")
    ap.add_argument("--comfyui-url", help="use a ComfyUI that's already running here instead of starting one")
    ap.add_argument("--mock", action="store_true", help="start the stand-in ComfyUI (no GPU, no models)")
    ap.add_argument("--lowvram", choices=["auto", "on", "off"], default="auto",
                    help="ComfyUI's --lowvram (auto: on under 24 GB of VRAM)")
    ap.add_argument("--force", action="store_true", help="start ComfyUI even with no NVIDIA GPU")
    ap.add_argument("--comfy-port", type=int, default=8188)
    ap.add_argument("--proxy-port", type=int, default=8189)
    ap.add_argument("--port", type=int, default=8190, help="render server port (the app's This computer uses 8190)")
    ap.add_argument("--cors-origin", action="append", help="pages that may call the server (default: the live "
                    "page and the dev servers on localhost)")
    args = ap.parse_args(argv)

    if answers(f"http://127.0.0.1:{args.port}/api/health"):
        raise SystemExit(f"Something already answers on port {args.port}: a render server is already running?")

    stack = Stack()
    try:
        comfy_url = args.comfyui_url or f"http://127.0.0.1:{args.comfy_port}"
        print("== ComfyUI")
        if args.mock:
            proc = stack.start("comfyui", [sys.executable, "-m", "server.mock_comfyui", "--port", str(args.comfy_port)])
            stack.wait_for("comfyui", proc, f"{comfy_url}/object_info", 60)
        elif args.comfyui_url:
            if not answers(f"{comfy_url}/object_info"):
                raise SystemExit(f"No ComfyUI answers at {comfy_url}")
            print(f"  using {comfy_url}")
            check_models(comfy_url)
        else:
            low = check_hardware(args.force)
            low = {"on": True, "off": False}.get(args.lowvram, low)
            comfy_dir = find_comfyui(args.comfyui_dir)
            if not comfy_dir:
                raise SystemExit("ComfyUI not found. Run scripts/setup_local.sh (or setup_local.ps1 on Windows), "
                                 "or pass --comfyui-dir / --comfyui-url.")
            cmd = comfyui_command(comfy_dir, venv_python(comfy_dir), args.comfy_port, low)
            proc = stack.start("comfyui", cmd, cwd=comfy_dir)
            print("  waiting for ComfyUI (the first start can take a few minutes)")
            stack.wait_for("comfyui", proc, f"{comfy_url}/object_info", 900)
            check_models(comfy_url)

        print("== comfy-api-proxy")
        proxy = stack.start("proxy", [sys.executable, "-c", "from comfy_api_proxy.cli import main; main()",
                                      "--comfyui", comfy_url, "--port", str(args.proxy_port)])
        stack.wait_for("proxy", proxy, f"http://127.0.0.1:{args.proxy_port}/", 60)

        print("== render server")
        origins = args.cors_origin or ORIGINS
        srv = stack.start("server", server_command(args.proxy_port, args.port, origins))
        stack.wait_for("server", srv, f"http://127.0.0.1:{args.port}/api/health", 60)

        print(f"\nReady on http://127.0.0.1:{args.port}. In the app: Render... > This computer."
              + ("\n(Stand-in ComfyUI: renders are copies of the playblast.)" if args.mock else "")
              + "\nCtrl+C stops it all.")
        while all(p.poll() is None for _, p, _ in stack.procs):
            time.sleep(1)
        dead = next(n for n, p, _ in stack.procs if p.poll() is not None)
        print(f"{dead} stopped; see {LOGS / (dead + '.log')}:\n{tail(LOGS / f'{dead}.log')}")
        return 1
    except KeyboardInterrupt:
        print("\nStopping...")
        return 0
    finally:
        stack.stop()


if __name__ == "__main__":
    sys.exit(main())
