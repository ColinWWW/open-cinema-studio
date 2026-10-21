"""Check a render setup before spending GPU time: Python packages, ffmpeg, the Comfy target, and (for a
self-hosted ComfyUI) that every node and model file our workflows use is there.

    python -m server.doctor                                  # local checks + the target from the env
    python -m server.doctor --comfyui http://127.0.0.1:8188  # also ask ComfyUI itself (/object_info)

Exits 1 if anything is missing, with what to do about it.
"""

import argparse
import importlib
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

from .workflow import WORKFLOW_FILES

# Where missing model files come from, by workflow.
SETUP = {"look_still_depth_api.json": "bash scripts/setup_look_models.sh"}
SETUP_DEFAULT = "bash scripts/setup_pod.sh"
INPUT_LOADERS = {"LoadImage", "LoadVideo"}  # their files are uploaded with each job
PACKAGES = {"comfy_sdk": "comfy-sdk", "aiohttp": "aiohttp", "imageio_ffmpeg": "imageio-ffmpeg"}


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


def fetch_object_info(url, timeout=20):
    with urllib.request.urlopen(f"{url.rstrip('/')}/object_info", timeout=timeout) as r:
        return json.load(r)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--comfyui", help="your ComfyUI's own URL (e.g. http://127.0.0.1:8188, not the proxy) to check nodes and models")
    args = ap.parse_args(argv)

    results = local_checks() + target_checks()
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
