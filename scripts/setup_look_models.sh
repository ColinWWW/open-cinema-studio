#!/usr/bin/env bash
# Look-still models (~27.4 GB): Z-Image-Turbo + alibaba-pai's Fun ControlNet Union 2.1 (depth).
# Both Apache-2.0 and not gated, so no Hugging Face token is needed. Safe to re-run (downloads resume).
#   bash scripts/setup_look_models.sh
set -euo pipefail

if [[ -z "${COMFY_DIR:-}" ]]; then
  for d in /workspace/runpod-slim/ComfyUI /workspace/ComfyUI /ComfyUI; do
    [[ -f "$d/main.py" ]] && COMFY_DIR="$d" && break
  done
fi
[[ -n "${COMFY_DIR:-}" ]] || { echo "ComfyUI not found; set COMFY_DIR"; exit 1; }
M="$COMFY_DIR/models"

free_gb=$(df -BG --output=avail "$M" | tail -1 | tr -dc 0-9)
echo "== Look-still models into $M (${free_gb}G free, need ~28G)"
(( free_gb >= 30 )) || { echo "!! not enough space"; exit 1; }

get() {  # get <repo> <file-in-repo> <dest-dir>
  mkdir -p "$3"
  wget -c -q --show-progress -O "$3/$(basename "$2")" "https://huggingface.co/$1/resolve/main/$2"
}
Z=Comfy-Org/z_image_turbo
C=alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1
get $Z split_files/diffusion_models/z_image_turbo_bf16.safetensors "$M/diffusion_models"   # 12.3 GB
get $Z split_files/text_encoders/qwen_3_4b.safetensors "$M/text_encoders"                  # 8.0 GB
get $Z split_files/vae/ae.safetensors "$M/vae"                                             # 0.3 GB
get $C Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors "$M/model_patches"   # 6.7 GB

bad=0
for f in diffusion_models/z_image_turbo_bf16.safetensors text_encoders/qwen_3_4b.safetensors vae/ae.safetensors \
         model_patches/Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors; do
  if [[ ! -s "$M/$f" ]]; then echo "!! missing: $M/$f"; bad=1; else ls -lh "$M/$f"; fi
done
df -h "$M"
exit $bad
