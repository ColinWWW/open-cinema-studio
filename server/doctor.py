"""Check a render setup before spending GPU time: Python packages, ffmpeg, the Comfy target, and (for a
self-hosted ComfyUI) that every node and model file our workflows use is there.

    python -m server.doctor                                  # local checks + the target from the env
    python -m server.doctor --comfyui http://127.0.0.1:8188  # also ask ComfyUI itself (/object_info)
    python -m server.doctor --local                          # also: are this computer's GPU and RAM enough?

Exits 1 if anything is missing, with what to do about it.
"""

import argparse
import ctypes
import importlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

from .workflow import WORKFLOW_FILES

# Where missing model files come from, by workflow.
SETUP = {"look_still_depth_api.json": "bash scripts/setup_look_models.sh"}
SETUP_DEFAULT = "bash scripts/setup_pod.sh"
INPUT_LOADERS = {"LoadImage", "LoadVideo"}  # their files are uploaded with each job
PACKAGES = {"comfy_sdk": "comfy-sdk", "aiohttp": "aiohttp", "imageio_ffmpeg": "imageio-ffmpeg"}

# Rendering on this computer. LTX-2.5's int8 transformer alone is ~22 GB and the Gemma encoder ~12 GB: with 24 GB
# of VRAM ComfyUI swaps them in turn; below that it streams weights from RAM (--lowvram), slower; below 16 GB a
# video render won't fit. The look still (Z-Image-Turbo ~12 GB + an 8 GB encoder) streams on smaller cards.
VRAM_FULL_GB, VRAM_MIN_GB, VRAM_LOOK_GB = 24, 16, 8
RAM_MIN_GB, RAM_GOOD_GB = 32, 64


def combo_options(spec):
    """The allowed values of an /object_info input spec, or None if it isn't a list (combo) input."""
    if not isinstance(spec, list) or not spec:
        return None
    if isinstance(spec[0], list):  # legacy format: [[options...], {...}]
        return spec[0]
    if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1].get("options")
    return None


def check_graphs(object_info, graphs):
    """Problems running `graphs` ({name: API graph}) on a ComfyUI with this /object_info. Empty = all good."""
    problems = []
    for name, graph in graphs.items():
        for nid, node in graph.items():
            cls = node["class_type"]
            info = object_info.get(cls)
            setup = SETUP.get(name, SETUP_DEFAULT)
            title = node.get("_meta", {}).get("title", cls)
            if info is None:
                problems.append(f"{name}: node {cls} ({title}) is missing: update ComfyUI (core nodes only, no custom nodes needed)")
                continue
            specs = {**info.get("input", {}).get("required", {}), **info.get("input", {}).get("optional", {})}
            for key, value in node["inputs"].items():
                if isinstance(value, list) or "." in key:  # links and dynamic sub-inputs
                    continue
                if key not in specs:
                    problems.append(f"{name}: {cls} ({title}) has no input {key!r}: ComfyUI version mismatch?")
                    continue
                options = combo_options(specs[key])
                if options is not None and isinstance(value, str) and value not in options and cls not in INPUT_LOADERS:
                    problems.append(f"{name}: {title}: {value} not found ({cls}.{key}); run {setup}")
    return sorted(set(problems))


def local_checks():
    """(ok, message) for the Python side of the render server."""
    out = [(sys.version_info >= (3, 10), f"Python {sys.version.split()[0]} (3.10+ needed)")]
    for mod, pkg in PACKAGES.items():
        try:
            importlib.import_module(mod)
            out.append((True, f"{pkg} installed"))
        except ImportError:
            out.append((False, f"{pkg} missing: pip install -r server/requirements.txt"))
    ff = shutil.which("ffmpeg")
    if not ff:
        try:
            ff = importlib.import_module("imageio_ffmpeg").get_ffmpeg_exe()
        except Exception:  # noqa: BLE001
            ff = None
    out.append((bool(ff), f"ffmpeg: {ff}" if ff else "ffmpeg missing: install it or pip install imageio-ffmpeg"))
    return out


def target_checks(env=os.environ):
    base = env.get("COMFY_BASE_URL")
    if base:
        return [(True, f"Comfy target: {base} (self-hosted, via comfy-api-proxy)")]
    if env.get("COMFY_API_KEY"):
        return [(True, "Comfy target: Comfy Cloud (COMFY_API_KEY set)")]
    return [(False, "Comfy target: Comfy Cloud, but COMFY_API_KEY isn't set. Set it, or use --comfy-url / COMFY_BASE_URL for your own ComfyUI")]


def gpus():
    """[(name, memory in GB)] of this computer's NVIDIA GPUs, from nvidia-smi ([] if there are none)."""
    smi = shutil.which("nvidia-smi")
    if not smi:
        return []
    try:
        out = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=20, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    found = []
    for line in out.strip().splitlines():
        name, _, mib = line.rpartition(",")
        try:
            found.append((name.strip(), round(float(mib) / 1024, 1)))
        except ValueError:
            continue
    return found


def ram_gb():
    """This computer's RAM in GB, or None if it can't be read."""
    try:
        if sys.platform == "win32":
            class MemoryStatus(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                    (name, ctypes.c_ulonglong) for name in
                    ("total", "avail", "page_total", "page_avail", "virt_total", "virt_avail", "ext_avail")]
            s = MemoryStatus(length=ctypes.sizeof(MemoryStatus))
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return round(s.total / 2**30, 1)
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, check=True).stdout
            return round(int(out) / 2**30, 1)
        with open("/proc/meminfo") as f:
            return round(int(f.readline().split()[1]) / 2**20, 1)
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        return None


def lowvram(vram):
    """Should ComfyUI run with --lowvram on a card with `vram` GB?"""
    return vram < VRAM_FULL_GB


def hardware_checks(found, ram):
    """(ok, message) for rendering on this computer, from gpus() and ram_gb()."""
    if not found:
        return [(False, "No NVIDIA GPU found: rendering on this computer needs one. Use Comfy Cloud or a GPU pod instead")]
    name, vram = max(found, key=lambda g: g[1])
    if vram >= VRAM_FULL_GB:
        out = [(True, f"GPU: {name}, {vram:g} GB (video renders fit)")]
    elif vram >= VRAM_MIN_GB:
        out = [(True, f"GPU: {name}, {vram:g} GB: video renders should run in ComfyUI's --lowvram mode, slower "
                      f"({VRAM_FULL_GB} GB+ recommended)")]
    else:
        look = "look stills will run, slowly" if vram >= VRAM_LOOK_GB else "even look stills may not fit"
        out = [(False, f"GPU: {name}, {vram:g} GB: too small for video renders (needs {VRAM_MIN_GB} GB, "
                       f"{VRAM_FULL_GB}+ recommended); {look}. Render on a GPU pod or Comfy Cloud instead")]
    if ram is None:
        out.append((True, f"RAM: couldn't read it ({RAM_GOOD_GB} GB recommended)"))
    elif ram >= RAM_GOOD_GB:
        out.append((True, f"RAM: {ram:g} GB"))
    elif ram >= RAM_MIN_GB - 1:  # a 32 GB machine reports a little under 32
        out.append((True, f"RAM: {ram:g} GB: enough, but model swaps will be slow ({RAM_GOOD_GB} GB recommended)"))
    else:
        out.append((False, f"RAM: {ram:g} GB: the models need at least {RAM_MIN_GB} GB ({RAM_GOOD_GB} GB recommended)"))
    return out


def is_local(url):
    return urllib.parse.urlsplit(url or "").hostname in ("127.0.0.1", "localhost", "::1")


def fetch_object_info(url, timeout=20):
    with urllib.request.urlopen(f"{url.rstrip('/')}/object_info", timeout=timeout) as r:
        return json.load(r)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--comfyui", help="your ComfyUI's own URL (e.g. http://127.0.0.1:8188, not the proxy) to check nodes and models")
    ap.add_argument("--local", action="store_true",
                    help="also check this computer's GPU and RAM (automatic when --comfyui is on localhost)")
    args = ap.parse_args(argv)

    results = local_checks() + target_checks()
    if args.local or is_local(args.comfyui):
        results += hardware_checks(gpus(), ram_gb())
    if args.comfyui:
        try:
            info = fetch_object_info(args.comfyui)
            graphs = {name: build() for name, build in WORKFLOW_FILES.items()}
            problems = check_graphs(info, graphs)
            results += [(False, p) for p in problems] or [(True, f"ComfyUI at {args.comfyui} has every node and model file")]
        except (urllib.error.URLError, OSError, ValueError) as e:
            results.append((False, f"ComfyUI at {args.comfyui} didn't answer /object_info ({e})"))
    for ok, msg in results:
        print(("ok   " if ok else "FIX  ") + msg)
    bad = sum(not ok for ok, _ in results)
    print("All good." if not bad else f"{bad} thing(s) to fix.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
