#!/usr/bin/env bash
# One-command pod setup: LTX-2.5 + Layout-to-Render IC-LoRA on the RunPod "ComfyUI - CUDA 12.8" template.
# Safe to re-run (downloads resume). Run from a JupyterLab terminal on the pod:
#   bash scripts/setup_pod.sh
# Needs a Hugging Face Read token, with "Agree and Access" clicked on BOTH:
#   https://huggingface.co/Lightricks/LTX-2.5
#   https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${COMFY_DIR:-}" ]]; then
  for d in /workspace/runpod-slim/ComfyUI /workspace/ComfyUI /ComfyUI; do
    [[ -f "$d/main.py" ]] && COMFY_DIR="$d" && break
  done
fi
[[ -n "${COMFY_DIR:-}" ]] || { echo "ComfyUI not found; set COMFY_DIR"; exit 1; }
M="$COMFY_DIR/models"
echo "ComfyUI: $COMFY_DIR"

echo "== Disk"
df -h /workspace
size_gb=$(df -BG --output=size /workspace | tail -1 | tr -dc 0-9)
if (( size_gb < 80 )); then
  echo "!! /workspace is only ${size_gb}G; the models need ~70G (LTX ~42G + look still ~28G) plus ComfyUI."
  echo "   If the volume shows ~10G, the 100G resize didn't apply: rm -rf /workspace/runpod-slim, terminate, redeploy."
  exit 1
fi

echo "== ComfyUI-LTXVideo"
PY="$( [[ -x "$COMFY_DIR/.venv/bin/python" ]] && echo "$COMFY_DIR/.venv/bin/python" || command -v python3 )"
N="$COMFY_DIR/custom_nodes/ComfyUI-LTXVideo"
if [[ -d "$N" ]]; then git -C "$N" pull --ff-only || true; else git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo "$N"; fi
[[ -f "$N/requirements.txt" ]] && "$PY" -m pip install -q -r "$N/requirements.txt"

echo "== Models (~42 GB, int8: Ampere has hardware int8)"
if [[ -z "${HF_TOKEN:-}" ]]; then read -r -s -p "HF token: " HF_TOKEN; echo; fi
get() {  # get <repo> <file-in-repo> <dest-dir>
  mkdir -p "$3"
  wget -c -q --show-progress --header="Authorization: Bearer $HF_TOKEN" \
    -O "$3/$(basename "$2")" "https://huggingface.co/$1/resolve/main/$2"
}
B=Lightricks/LTX-2.5
L=Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render
get $B diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors "$M/diffusion_models"
get $B text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors "$M/text_encoders"
get $B vae/ltx-2.5-video-vae-bf16.safetensors "$M/vae"
get $B vae/ltx-2.5-audio-vae-bf16.safetensors "$M/vae"
get $B latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors "$M/latent_upscale_models"
get $L ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors "$M/loras"
# Official workflow: keep it out of the repo (LTX license), drop it where ComfyUI's workflow browser sees it.
get $L LTX-2.5_ICLoRA_Layout_To_Render_Two_Stage_Distilled.json "$COMFY_DIR/user/default/workflows"

echo "== Check"
bad=0
for f in "$M"/diffusion_models/ltx-2.5-* "$M"/text_encoders/gemma4-* "$M"/vae/ltx-2.5-* \
         "$M"/latent_upscale_models/ltx-2.5-* "$M"/loras/ltx-2.5-*; do
  if [[ ! -s "$f" ]]; then echo "!! empty: $f (repo terms not accepted, or wrong path)"; bad=1; fi
done
ls -lh "$M"/diffusion_models "$M"/text_encoders "$M"/vae "$M"/latent_upscale_models "$M"/loras
df -h /workspace
(( bad )) && exit 1

COMFY_DIR="$COMFY_DIR" bash "$REPO_DIR/scripts/setup_look_models.sh"   # look still: Z-Image-Turbo + depth ControlNet

echo
echo "Done. Restart ComfyUI, open LTX-2.5_ICLoRA_Layout_To_Render_Two_Stage_Distilled from the workflow"
echo "browser and switch each loader to the int8 files. Run stage 1 only first."
echo "Budget guard (every GPU pod):"
echo "  nohup bash $REPO_DIR/scripts/idle_shutdown.sh > /workspace/idle_shutdown.log 2>&1 &"
