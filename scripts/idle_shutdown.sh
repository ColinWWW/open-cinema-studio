#!/usr/bin/env bash
# Budget guard: terminates this pod when ComfyUI has been idle for IDLE_MIN minutes,
# or when the pod has run MAX_HOURS in total. Everything on /workspace (network volume) survives.
#
# Start it every time you start a pod:
#   nohup bash /workspace/reshoot/scripts/idle_shutdown.sh > /workspace/idle_shutdown.log 2>&1 &
# Options (env): IDLE_MIN=20 MAX_HOURS=4 COMFY=http://127.0.0.1:8188 BUSY_FILE=/tmp/reshoot.busy
set -uo pipefail

IDLE_MIN="${IDLE_MIN:-20}"
MAX_HOURS="${MAX_HOURS:-4}"
COMFY="${COMFY:-http://127.0.0.1:8188}"
BUSY_FILE="${BUSY_FILE:-/tmp/reshoot.busy}"

if [[ -z "${RUNPOD_POD_ID:-}" ]]; then
  echo "!! RUNPOD_POD_ID missing: budget guard is NOT active" >&2
  exit 1
fi
if [[ -z "${RUNPOD_API_KEY:-}" ]] && ! command -v runpodctl >/dev/null; then
  echo "!! neither RUNPOD_API_KEY nor runpodctl available: budget guard is NOT active" >&2
  exit 1
fi

# Terminate (not stop): pods with a network volume can only be terminated, and /workspace survives.
# runpodctl is injected a few seconds after the container starts and is the v1 CLI (`remove pod`);
# the pod's RUNPOD_API_KEY gets 403 from the REST API, so REST is only a last resort.
terminate_pod() {
  if command -v runpodctl >/dev/null; then
    runpodctl remove pod "$RUNPOD_POD_ID" && return 0
    runpodctl pod delete "$RUNPOD_POD_ID" && return 0
  fi
  if [[ -n "${RUNPOD_API_KEY:-}" ]]; then
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE \
      -H "Authorization: Bearer $RUNPOD_API_KEY" "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID")"
    echo "$(date) REST terminate -> HTTP $code"
    [[ "$code" == 2* ]] && return 0
  fi
  return 1
}

shutdown_pod() {
  echo "$(date) shutting down: $1"
  # Keep retrying until the pod disappears; never exit while it's still billing.
  until terminate_pod; do
    echo "$(date) terminate failed, retrying in 30s" >&2
    sleep 30
  done
  sleep infinity
}

busy() {
  local q
  # Long jobs outside ComfyUI (setup_pod.sh downloads) hold this file to count as busy.
  [[ -e "$BUSY_FILE" ]] && return 0
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
