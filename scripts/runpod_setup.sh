#!/usr/bin/env bash
# Set up Reshoot on a RunPod ComfyUI pod. Safe to re-run.
# Usage: bash scripts/runpod_setup.sh        (from the repo root, cloned into /workspace)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Find ComfyUI (the RunPod template has moved it between versions).
if [[ -z "${COMFY_DIR:-}" ]]; then
  for d in /workspace/runpod-slim/ComfyUI /workspace/ComfyUI /ComfyUI; do
    [[ -f "$d/main.py" ]] && COMFY_DIR="$d" && break
  done
fi
[[ -n "${COMFY_DIR:-}" ]] || { echo "ComfyUI not found; set COMFY_DIR"; exit 1; }
echo "ComfyUI: $COMFY_DIR"

# Python ComfyUI runs with (template venv if present).
PY="${PY:-$( [[ -x "$COMFY_DIR/.venv/bin/python" ]] && echo "$COMFY_DIR/.venv/bin/python" || command -v python3 )}"
echo "Python: $PY"

echo "== Updating ComfyUI (LTX-2 support needs a recent build)"
git -C "$COMFY_DIR" pull --ff-only || echo "!! could not fast-forward ComfyUI; update it manually"
"$PY" -m pip install -q -r "$COMFY_DIR/requirements.txt"

echo "== Custom node packs"
cd "$COMFY_DIR/custom_nodes"
clone() { [[ -d "$2" ]] && git -C "$2" pull --ff-only || git clone --depth 1 "$1" "$2"; }
clone https://github.com/Lightricks/ComfyUI-LTXVideo ComfyUI-LTXVideo
clone https://github.com/kijai/ComfyUI-DepthAnythingV2 ComfyUI-DepthAnythingV2
clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite ComfyUI-VideoHelperSuite
for d in ComfyUI-LTXVideo ComfyUI-DepthAnythingV2 ComfyUI-VideoHelperSuite; do
  [[ -f "$d/requirements.txt" ]] && "$PY" -m pip install -q -r "$d/requirements.txt"
done
ln -sfn "$REPO_DIR/custom_nodes/comfyui-reshoot" comfyui-reshoot

echo "== Models"
# Keep models on the network volume so they survive pod restarts.
"$PY" -m pip install -q -U "huggingface_hub[cli]"
M="$COMFY_DIR/models"
mkdir -p "$M/checkpoints" "$M/loras" "$M/text_encoders" "$M/depthanything"

# TODO(day 1): fill in exact filenames from the LTX-2 model card, e.g.
#   hf download Lightricks/LTX-2 <checkpoint>.safetensors --local-dir "$M/checkpoints"
#   hf download Lightricks/<depth-ic-lora-repo> <file>.safetensors --local-dir "$M/loras"
#   plus the text encoder the LTX-2 ComfyUI example workflow asks for.
# Depth Anything V2 Small is downloaded by the DepthAnythingV2 node on first use.
# Use the *Small* model only: Base/Large are CC-BY-NC.

echo "== App dependencies"
"$PY" -m pip install -q -r "$REPO_DIR/requirements.txt"

echo
echo "Done. Restart ComfyUI, then check the 'Reshoot' node category appears."
echo "Budget guard (run on every GPU pod):"
echo "  nohup bash $REPO_DIR/scripts/idle_shutdown.sh > /workspace/idle_shutdown.log 2>&1 &"
echo "App: $PY $REPO_DIR/app/app.py --comfy http://127.0.0.1:8188   (expose port 7860 on the pod)"
