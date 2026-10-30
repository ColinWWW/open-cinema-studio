#!/usr/bin/env bash
# Start a pod's render stack on boot, so the only step left is pasting the pod's URL into the app.
# For the RunPod "ComfyUI - CUDA 12.8" template, which starts ComfyUI itself (port 8188). This adds the
# budget guard (scripts/idle_shutdown.sh), then comfy-api-proxy and the render server (python -m server.local,
# port 8190, open to the pod's proxy URL), and prints that URL.
#
# Once, after scripts/setup_pod.sh: in the pod's settings, expose HTTP port 8190 and set the Container Start Command to
#   bash -c "bash /workspace/cinema-studio/scripts/start_pod.sh & exec /start.sh"
# (/start.sh is the template's own startup: ComfyUI, SSH, Jupyter. Keep it.) Or run it by hand on a running pod:
#   bash scripts/start_pod.sh
# Safe to run twice: it skips whatever already answers. Log: /workspace/start_pod.log.
# Options (env): CORS_ORIGINS="https://a,https://b" (default: the live page), COMFY_WAIT_MIN=20,
#   NO_GUARD=1 (no budget guard), PY=/path/to/python (default: a venv in .venv-pod, made on first run).
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${LOG:-/workspace/start_pod.log}"
[[ -d "$(dirname "$LOG")" ]] || LOG="$REPO_DIR/server/logs/start_pod.log"
mkdir -p "$(dirname "$LOG")" "$REPO_DIR/server/logs"
exec >>"$LOG" 2>&1
echo "== $(date) start_pod"

COMFY="http://127.0.0.1:8188"
PORT=8190
CORS_ORIGINS="${CORS_ORIGINS:-https://colinwww.github.io}"
COMFY_WAIT_MIN="${COMFY_WAIT_MIN:-20}"

answers() { curl -s -o /dev/null --max-time 3 "$1"; }

# 1. The budget guard first, so a pod that never gets used still shuts itself down.
if [[ -n "${NO_GUARD:-}" ]]; then
  echo "budget guard: off (NO_GUARD)"
elif pgrep -f idle_shutdown.sh >/dev/null; then
  echo "budget guard: already running"
else
  # RunPod injects runpodctl a few seconds after the container starts, and the guard needs it (or RUNPOD_API_KEY).
  for _ in $(seq 30); do
    [[ -n "${RUNPOD_API_KEY:-}" ]] || command -v runpodctl >/dev/null && break
    sleep 2
  done
  nohup bash "$REPO_DIR/scripts/idle_shutdown.sh" >>"$(dirname "$LOG")/idle_shutdown.log" 2>&1 &
  guard=$!
  sleep 3
  if kill -0 "$guard" 2>/dev/null; then
    echo "budget guard: started (log $(dirname "$LOG")/idle_shutdown.log)"
  else
    echo "!! budget guard NOT running: the pod won't shut itself down. See $(dirname "$LOG")/idle_shutdown.log"
  fi
fi

if answers "http://127.0.0.1:$PORT/api/health"; then
  echo "render server: already running on port $PORT"
  exit 0
fi

# 2. A Python with the render server's packages, kept on the volume next to the repo (not ComfyUI's venv).
if [[ -z "${PY:-}" ]]; then
  PY="$REPO_DIR/.venv-pod/bin/python"
  if [[ ! -x "$PY" ]]; then
    echo "first run: making $REPO_DIR/.venv-pod"
    python3 -m venv "$REPO_DIR/.venv-pod" || { echo "!! python3 -m venv failed"; exit 1; }
  fi
  "$PY" -m pip install -q -r "$REPO_DIR/server/requirements.txt" || { echo "!! pip install failed"; exit 1; }
fi

# 3. Wait for the template's ComfyUI (a few minutes on a network volume).
echo "waiting for ComfyUI on $COMFY (up to ${COMFY_WAIT_MIN} min)"
deadline=$(( $(date +%s) + COMFY_WAIT_MIN * 60 ))
until answers "$COMFY/object_info"; do
  if (( $(date +%s) > deadline )); then
    echo "!! ComfyUI didn't answer in ${COMFY_WAIT_MIN} min; nothing started. Check the pod's logs, then: bash scripts/start_pod.sh"
    exit 1
  fi
  sleep 10
done

# 4. Proxy + render server. server.local checks the models, waits for each part and logs to server/logs/.
origins=()
IFS=',' read -ra list <<<"$CORS_ORIGINS"
for o in "${list[@]}"; do origins+=(--cors-origin "$o"); done
cd "$REPO_DIR" || exit 1
nohup "$PY" -m server.local --comfyui-url "$COMFY" --host 0.0.0.0 --port "$PORT" "${origins[@]}" \
  >>"$REPO_DIR/server/logs/local.log" 2>&1 &
for _ in $(seq 60); do
  if answers "http://127.0.0.1:$PORT/api/health"; then
    echo "render server: up. Paste this into the app's Render server URL:"
    echo "  https://${RUNPOD_POD_ID:-<pod-id>}-$PORT.proxy.runpod.net"
    exit 0
  fi
  sleep 2
done
echo "!! the render server didn't come up; see $REPO_DIR/server/logs/local.log"
exit 1
