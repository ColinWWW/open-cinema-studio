# Open Cinema Studio

Block out a shot with grey boxes and a camera path in your browser, give it one art-direction
frame, and get back a cinematic clip that follows your exact camera move and layout.
Open-weights only: **LTX-2.5 + the Layout-to-Render IC-LoRA**, running in ComfyUI.

Entry for the [Comfy Open Source Higgsfield Challenge](https://comfy.org/open-source-higgsfield)
(Open Weights Only + VFX Workflow Built with LTX). Name TBD.

> Status: early. The go/no-go render passed (stage 1 on an A40 follows the layout box for box when the
> first frame matches it). The blocking tool (`web/`) works locally; wiring it to ComfyUI is next.
> Plan, specs and budget: [docs/PLAN.md](docs/PLAN.md).

## How it works

1. **Block** — place primitives and keyframe a camera in a three.js editor.
2. **Playblast** — export the grey scene deterministically: 24 fps, 8k+1 frames, dimensions divisible by 64.
3. **Art-direct** — supply a finished-looking first frame.
4. **Render** — LTX-2.5 + Layout-to-Render follows the layout clip's camera and blocking, and takes its look from the first frame.

## Blocking tool

Needs Node 20+ and Chrome or Edge (the playblast is encoded in the browser with WebCodecs).

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173, add boxes, people and walls, then turn on **Look through shot camera**,
frame the shot and press **K** to key it on the timeline. **Export playblast** renders every frame at
exactly 1/24 s steps to an H.264 MP4 (960×576 or 1920×1088, 65/97/121 frames) plus a PNG of frame 0.
With the dev server running, exports are also written to `web/exports/`. Scenes save as JSON;
the **Blocks** and **Plaza** presets reproduce `scripts/make_test_layout.py`'s clips.

Tests: `cd web && npm test`.

## Try the pipeline now

Make a test layout clip locally (needs Python with numpy, and ffmpeg or `pip install imageio-ffmpeg`):

```bash
python scripts/make_test_layout.py --move dolly_in -o examples/layout_dolly_in.mp4
```

Moves: `dolly_in`, `orbit`, `crane_up`, `truck`.

## GPU setup (RunPod)

On a RunPod "ComfyUI – CUDA 12.8" pod with a ≥ 60 GB volume at `/workspace`:

```bash
cd /workspace && git clone <this repo> cinema-studio && cd cinema-studio
nohup bash scripts/idle_shutdown.sh > /workspace/idle_shutdown.log 2>&1 &   # terminates the pod when idle
bash scripts/setup_pod.sh                                                   # ComfyUI-LTXVideo + ~42 GB of models
```

First accept the terms on both gated Hugging Face repos (see below) and have a Read token ready.

## Models and licenses

| Model | Use | License |
|---|---|---|
| [LTX-2.5 22B distilled (int8)](https://huggingface.co/Lightricks/LTX-2.5) + Gemma text encoder, VAEs, x2 upscaler | video generation | LTX-2.x community license (gated) |
| [LTX-2.5 IC-LoRA Layout-to-Render](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render) | layout → finished shot | LTX-2.x community license (gated) |

No partner nodes or closed APIs are used. Check any workflow with
`python scripts/check_open_weights.py workflows/*.json`.

## License

Code: MIT ([LICENSE](LICENSE)). Model weights are under their own licenses above.
