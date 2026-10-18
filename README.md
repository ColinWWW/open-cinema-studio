# Reshoot

Re-film any video from a new camera angle: orbit around the subject, crane up, dolly in.
Built on ComfyUI with **open-weights models only** (LTX-2 + Depth Anything V2 Small).

Entry for the [Comfy Open Source Higgsfield Challenge](https://comfy.org/open-source-higgsfield):
Open Weights Only + VFX Workflow Built with LTX.

## How it works

1. **Depth** — Depth Anything V2 estimates depth for every frame.
2. **Re-projection** — the `comfyui-reshoot` node pack lifts each frame into 3D and re-renders it
   from a new camera path. You get a warped clip, depth from the new viewpoint, and a mask of
   everything the original camera never saw.
3. **Generation** — LTX-2 regenerates the clip, guided by the new-view depth (IC-LoRA) and the
   first frame, and fills in the unseen areas.

Full design: [docs/WORKFLOW_PLAN.md](docs/WORKFLOW_PLAN.md).

## Repo layout

| Path | What |
|---|---|
| `custom_nodes/comfyui-reshoot/` | ComfyUI nodes: Camera Move, Depth Warp, Fit for LTX |
| `app/` | Gradio web app that drives ComfyUI over its API |
| `workflows/` | ComfyUI workflows (UI + API format) |
| `scripts/runpod_setup.sh` | One-shot setup on a RunPod ComfyUI pod |
| `scripts/check_open_weights.py` | Scans a workflow for API/partner nodes |
| `tests/` | Unit tests for the camera and warp maths |

## Setup (RunPod)

```bash
cd /workspace && git clone <this repo> reshoot && cd reshoot
bash scripts/runpod_setup.sh
# restart ComfyUI, load workflows/reshoot.json, then:
python app/app.py --comfy http://127.0.0.1:8188
```

Expose HTTP port 7860 on the pod to reach the app.

## Models and licenses

| Model | Use | License |
|---|---|---|
| LTX-2 (Lightricks) | video generation | LTX open-weights license |
| LTX-2 depth IC-LoRA | structure guidance | LTX open-weights license |
| Depth Anything V2 Small | depth estimation | Apache-2.0 |

No partner nodes or closed APIs are used anywhere: in the workflow or in the app.
Check with `python scripts/check_open_weights.py workflows/*.json`.

## License

Code: MIT (see [LICENSE](LICENSE)). Models are under their own licenses above.
