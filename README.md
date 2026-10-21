# Open Cinema Studio

[![CI](https://github.com/ColinWWW/open-cinema-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ColinWWW/open-cinema-studio/actions/workflows/ci.yml)

Block out a shot with grey boxes and a camera path in your browser, give it one art-direction
frame, and get back a cinematic clip that follows your exact camera move and layout.
Open-weights only: **LTX-2.5 + the Layout-to-Render IC-LoRA** for the clip and **Z-Image-Turbo + a depth
ControlNet** for the art-direction frame, running in ComfyUI.

Entry for the [Comfy Open Source Higgsfield Challenge](https://comfy.org/open-source-higgsfield)
(Open Weights Only + VFX Workflow Built with LTX). Name TBD.

> Status: early. The go/no-go render passed (stage 1 on an A40 follows the layout box for box when the
> first frame matches it). The blocking tool (`web/`) works locally, and its **Render** button drives
> ComfyUI through the Comfy SDK. Our core-node workflow matches the go/no-go render on an A40.
> **Generate look still** (depth-controlled first frame) passed on an A40 too: the generated plaza still
> fed straight into the video render keeps both the look and the layout
> (`examples/look_gen_plaza_a40.png`, `examples/stage1_genlook_plaza_a40.mp4`, contact sheet
> `examples/stage1_genlook_plaza_frames.png`).
> Plan, specs and budget: [docs/PLAN.md](docs/PLAN.md).

## Try it

**Live:** https://colinwww.github.io/open-cinema-studio/ *(goes live on submission night)*. Use Chrome or Edge.

The page is the whole blocking tool: load the **Plaza** preset (or block your own shot), scrub the
camera, and **Export playblast**, all in your browser. **Render…** needs a render server with a GPU
behind it; when none answers, the panel shows a **Demo**: the bundled plaza example (layout clip, its
depth, the look still generated from it and the LTX-2.5 render, all real A40 outputs from `examples/`).

To render your own shots from the live page, start the render server (setup and Comfy targets in
[Render](#render-comfy-sdk)) so that the page may call it, then paste its URL (`http://127.0.0.1:8190`)
into **Render server URL**. Chrome may ask to let the page reach devices on your local network: allow it.

```bash
python -m server.app --cors-origin https://colinwww.github.io     # + --comfy-url for your own ComfyUI
```

## How it works

1. **Block** — place primitives and keyframe a camera in a three.js editor.
2. **Playblast** — export the grey scene deterministically: 24 fps, 8k+1 frames, dimensions divisible by 64.
3. **Art-direct** — generate a finished-looking first frame from the layout's depth and your prompt (or bring your own).
4. **Render** — LTX-2.5 + Layout-to-Render follows the layout clip's camera and blocking, and takes its look from the first frame.

## Blocking tool

Needs Node 20+ and Chrome or Edge (the playblast is encoded in the browser with WebCodecs).

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173, add boxes, people and walls, then turn on **Look through shot camera**,
frame the shot and press **K** to key it on the timeline. **Export playblast** renders every frame at
exactly 1/24 s steps to an H.264 MP4 (960×576 or 1920×1088, 65/97/121 frames) plus PNGs of frame 0 and
its depth map (near = white, sky = black).
With the dev server running, exports are also written to `web/exports/`. Scenes save as JSON;
the **Blocks** and **Plaza** presets reproduce `scripts/make_test_layout.py`'s clips.

Tests: `cd web && npm test`.

## Render (Comfy SDK)

`server/` is a small local server that takes the playblast, a look still and a prompt, runs our
stage-1 workflow ([workflows/stage1_layout_api.json](workflows/stage1_layout_api.json), built from
ComfyUI core nodes by `server/workflow.py`) through the official
[Comfy SDK](https://docs.comfy.org/development/api-development/sdks), and returns the clip.
The SDK talks to Comfy Cloud by default, or to any ComfyUI behind
[comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) via `COMFY_BASE_URL`.

```bash
pip install -r server/requirements.txt
COMFY_API_KEY=comfyui-... python -m server.app                          # Comfy Cloud (paid plan)
python -m server.app --comfy-url http://127.0.0.1:8189                  # your own ComfyUI + comfy-api-proxy
COMFY_API_KEY=<proxy token> python -m server.app --comfy-url https://<pod>-8189.proxy.runpod.net   # RunPod
```

`--cors-origin <origin>` lets a page served from elsewhere (the live link) call the server; `--host 0.0.0.0`
listens beyond localhost (e.g. on a pod, then use its `https://<pod>-8190.proxy.runpod.net` URL).

Then in `web/` (`npm run dev`) press **Render…**, write a one- or two-sentence prompt describing the
finished shot, and press **Generate look still**: the panel exports the playblast (only if the scene
changed), sends frame 0's depth map to our look-still workflow
([workflows/look_still_depth_api.json](workflows/look_still_depth_api.json): Z-Image-Turbo + the Fun
ControlNet Union in depth mode, core nodes only), and shows the still next to frame 0 and its depth.
Because the still is generated from the layout's own depth, it lines up with the playblast box for box,
which is what makes the video render keep both the look and the layout (a still that doesn't match
wins over the layout). Not happy? Change the seed or the prompt and generate again. Then press
**Render shot**. **Choose look still…** still takes your own image instead (same framing as frame 0).

Without the server:

```bash
python -m server.look web/exports/<shot>_depth.png "prompt" -o look.png        # look still (~1 MP, then playblast size)
python -m server.render web/exports/<shot>.mp4 look.png "prompt" -o out.mp4    # the clip
```

No GPU? Run the whole chain against a stand-in ComfyUI that returns the layout as the "render" (and
the depth map as the "look still"):

```bash
python -m server.mock_comfyui --port 8188 &
comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189 &
python -m server.app --comfy-url http://127.0.0.1:8189
```

Tests: `python -m unittest discover -s server/tests -t .` (the end-to-end ones start the mock and the proxy).

## Try the pipeline now

Make a test layout clip locally (needs Python with numpy, and ffmpeg or `pip install imageio-ffmpeg`):

```bash
python scripts/make_test_layout.py --move dolly_in -o examples/layout_dolly_in.mp4
```

Moves: `dolly_in`, `orbit`, `crane_up`, `truck`.

## GPU setup (RunPod)

On a RunPod "ComfyUI – CUDA 12.8" pod with a ≥ 80 GB volume at `/workspace`:

```bash
cd /workspace && git clone <this repo> cinema-studio && cd cinema-studio
nohup bash scripts/idle_shutdown.sh > /workspace/idle_shutdown.log 2>&1 &   # terminates the pod when idle
bash scripts/setup_pod.sh                                                   # ~42 GB LTX + ~28 GB look-still models
```

First accept the terms on both gated LTX repos (see below) and have a Read token ready. The look-still
models aren't gated; `bash scripts/setup_look_models.sh` fetches just those.

## Models and licenses

| Model | Use | License |
|---|---|---|
| [LTX-2.5 22B distilled (int8)](https://huggingface.co/Lightricks/LTX-2.5) + Gemma text encoder, VAEs, x2 upscaler | video generation | LTX-2.x community license (gated) |
| [LTX-2.5 IC-LoRA Layout-to-Render](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render) | layout → finished shot | LTX-2.x community license (gated) |
| [Z-Image-Turbo](https://huggingface.co/Comfy-Org/z_image_turbo) (bf16, Qwen3-4B text encoder, VAE) | look still (first frame) | Apache-2.0 |
| [Z-Image-Turbo Fun ControlNet Union 2.1](https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1) (2602, 8-step) | depth control for the look still | Apache-2.0 |

Why not FLUX 3 Image Klein for the still: it has no depth/structure control (no ControlNet or control
LoRA; its reference images and boxes guide content and placement but don't lock the layout), and a
look still that drifts from the layout gets the layout ignored.

> **Commercial use:** the weights are free to download and run, but their licenses limit commercial
> use (the LTX-2.x community license caps it by company revenue). If you use this project's output
> commercially, check each model's license and get a commercial license from the model maker where
> it's required. The MIT license below covers only this repo's code, not the models.

No partner nodes or closed APIs are used. Check any workflow with
`python scripts/check_open_weights.py workflows/*.json`.

## License

Code: MIT ([LICENSE](LICENSE)). Model weights are under their own licenses above.
