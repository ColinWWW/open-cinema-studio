#!/usr/bin/env bash
# Set up rendering on this computer (Linux, NVIDIA GPU): ComfyUI in ./ComfyUI, one Python venv in ./.venv with
# ComfyUI's and the render server's packages, and the models (~70 GB). Safe to re-run (downloads resume).
#   bash scripts/setup_local.sh                 # then: .venv/bin/python -m server.local
#   SKIP_MODELS=1 bash scripts/setup_local.sh   # everything but the models
# Needs git, Python 3.10-3.12 (set PYTHON=python3.12 to pick one), wget, ~80 GB of disk, and a Hugging Face Read
# token with "Agree and Access" clicked on both LTX repos (see setup_pod.sh). On Windows: scripts/setup_local.ps1.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMFY_DIR="${COMFY_DIR:-$REPO_DIR/ComfyUI}"
BASE_PY="${PYTHON:-python3}"
cd "$REPO_DIR"

echo "== This computer"
"$BASE_PY" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ needed"; print("Python", sys.version.split()[0])'
"$BASE_PY" -c 'from server.doctor import gpus, ram_gb, hardware_checks
for ok, msg in hardware_checks(gpus(), ram_gb()): print(("ok   " if ok else "WARN ") + msg)'

echo "== ComfyUI ($COMFY_DIR)"
if [[ -f "$COMFY_DIR/main.py" ]]; then
  git -C "$COMFY_DIR" pull --ff-only || echo "(couldn't update ComfyUI; keeping the version there)"
else
  git clone --depth 1 https://github.com/Comfy-Org/ComfyUI "$COMFY_DIR"
fi

echo "== Python packages (.venv)"
[[ -x .venv/bin/python ]] || "$BASE_PY" -m venv .venv
PY="$REPO_DIR/.venv/bin/python"
"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
"$PY" -m pip install -q -r "$COMFY_DIR/requirements.txt" -r server/requirements.txt -r requirements.txt

if [[ "${SKIP_MODELS:-}" == 1 ]]; then
  echo "SKIP_MODELS=1: models skipped. Run this again without it to fetch them."
else
  echo "== Models"
  COMFY_DIR="$COMFY_DIR" PY="$PY" bash scripts/setup_pod.sh
fi

echo
echo "== Check"
COMFY_BASE_URL=http://127.0.0.1:8189 "$PY" -m server.doctor --local || true   # server.local's proxy
echo
echo "Start rendering here with:   .venv/bin/python -m server.local"
echo "then in the app: Render... > This computer."
