#!/usr/bin/env bash
# Budget guard: terminates this pod when ComfyUI has been idle for IDLE_MIN minutes,
# or when the pod has run MAX_HOURS in total. Everything on /workspace (network volume) survives.
#
# Start it every time you start a pod:
#   nohup bash /workspace/reshoot/scripts/idle_shutdown.sh > /workspace/idle_shutdown.log 2>&1 &
# Options (env): IDLE_MIN=20 MAX_HOURS=4 COMFY=http://127.0.0.1:8188
set -uo pipefail

IDLE_MIN="${IDLE_MIN:-20}"
MAX_HOURS="${MAX_HOURS:-4}"
COMFY="${COMFY:-http://127.0.0.1:8188}"

if ! command -v runpodctl >/dev/null || [[ -z "${RUNPOD_POD_ID:-}" ]]; then
  echo "!! runpodctl or RUNPOD_POD_ID missing: budget guard is NOT active" >&2
  exit 1
fi

shutdown_pod() {
  echo "$(date) shutting down: $1"
  # Pods with a network volume can't be stopped, only terminated; fall back to stop otherwise.
  runpodctl remove pod "$RUNPOD_POD_ID" || runpodctl stop pod "$RUNPOD_POD_ID"
  exit 0
}

busy() {
  local q
  q="$(curl -s --max-time 5 "$COMFY/queue")" || return 1
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d["queue_running"] or d["queue_pending"] else 1)' "$q" 2>/dev/null
}

start=$(date +%s)
last_busy=$start
echo "$(date) guard on: idle ${IDLE_MIN}m, hard cap ${MAX_HOURS}h, pod $RUNPOD_POD_ID"
while true; do
  now=$(date +%s)
  busy && last_busy=$now
  (( now - start >= MAX_HOURS * 3600 )) && shutdown_pod "hard cap of ${MAX_HOURS}h reached"
  (( now - last_busy >= IDLE_MIN * 60 )) && shutdown_pod "idle for ${IDLE_MIN}m"
  sleep 60
done
