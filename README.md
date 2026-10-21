# Open Cinema Studio

[![CI](https://github.com/ColinWWW/open-cinema-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ColinWWW/open-cinema-studio/actions/workflows/ci.yml)

Block out a shot with grey boxes and a camera path in your browser, give it one art-direction
frame, and get back a cinematic clip that follows your exact camera move and layout.
Open-weights only: **LTX-2.5 + the Layout-to-Render IC-LoRA** for the clip and **Z-Image-Turbo + a depth
ControlNet** for the art-direction frame, running in ComfyUI.

Entry for the [Comfy Open Source Higgsfield Challenge](https://comfy.org/open-source-higgsfield)
(Open Weights Only + VFX Workflow Built with LTX). Name TBD. Submission checklist and demo shot list:
[docs/submission/](docs/submission/CHECKLIST.md).

<p align="center">
  <img src="docs/media/hero.gif" width="100%" alt="Left: the grey plaza layout, blocked in the browser, with a slow dolly-in. Right: the LTX-2.5 render of it on an A40, following the same camera move box for box.">
</p>
<p align="center"><sub>Left: the shot blocked in the browser (grey boxes + a keyed dolly-in). Right: the LTX-2.5 render, which
follows that camera move and layout. Real A40 output, stage 1, from <code>examples/</code>.</sub></p>

## 60 seconds

- **What it does:** you block out a shot in the browser (grey boxes and a keyed camera path), add one prompt,
  and get back a cinematic clip that follows that exact camera move and layout, rendered by LTX-2.5 in ComfyUI.
- **Why it's different:** you set the camera and the layout; the model only paints. The layout clip and its
  depth drive both the look still (Z-Image-Turbo + depth ControlNet) and the clip (LTX-2.5 + the Layout-to-Render
  IC-LoRA), so the render lines up box for box instead of reinterpreting your shot. Open weights only.
- **How to try it:** open the [live page](https://colinwww.github.io/open-cinema-studio/) (Chrome or Edge): it
  replays a real A40 render on first visit, and **Render…** takes a render server URL or your own Comfy key.
  No GPU? Run the whole chain locally against the [stand-in ComfyUI](#render-comfy-sdk).

<p align="center">
  <img src="docs/media/architecture.svg" width="100%" alt="Architecture: the browser blocks the shot in three.js and exports a WebCodecs playblast plus frame 0's depth; the render server (Comfy SDK) or the Comfy Cloud path with your own key sends them to ComfyUI, which paints the look still with Z-Image-Turbo + a depth ControlNet and films the clip with LTX-2.5 + the Layout-to-Render IC-LoRA (stage 1, then stage 2); the MP4 comes back to the page.">
</p>

**Measured on an A40:**

| Step | Size | Time |
| --- | --- | --- |
| Look still (Z-Image-Turbo + depth ControlNet) | about 1 MP | ~11 s warm, ~46–51 s cold |
| Stage 1 clip (LTX-2.5 + IC-LoRA) | 960×576, 65 frames | ~167 s |
| Stage 1 clip | 960×576, 121 frames (5 s) | 257 s |
| Stage 2 clip (x2 latent upscale + 3 refine steps) | 1920×1088, 97 frames | 373 s |

Single A40 runs on Oct 21; your times will vary.

> Status: both pipelines pass on an A40. The look still (Z-Image-Turbo + depth ControlNet) is generated from the
> layout's own depth, so it lines up box for box, and the stage-1 video render from it keeps both the look and the
> layout (see [Examples](#examples)). Stage 2 (1920×1088: an x2 latent upscale and 3 refine steps) runs on the
> A40 too: 97 frames in about 6 minutes, and it holds the layout at full resolution. Stage 1 also handles
> 121 frames (5 s) in about 4 minutes. Plan, specs and budget: [docs/PLAN.md](docs/PLAN.md).

## Try it

**Live:** https://colinwww.github.io/open-cinema-studio/ *(goes live on submission night)*. Use Chrome or Edge.

On a first visit the page replays a real render of the plaza example step by step (**▶ Demo** plays it
again): the layout, its depth, the look still and the LTX-2.5 render, with the real A40 timings sped up.
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

## Examples

All from the same plaza layout on an A40, stage 1 (960×576, 65 frames). Click a contact sheet for full size.

| Blocked in the browser | Look still, generated from its depth | LTX-2.5 render |
|---|---|---|
| <img src="examples/layout_plaza_dolly_in_first.png" width="280" alt="Grey plaza layout, frame 0"> | <img src="examples/look_gen_plaza_a40.png" width="280" alt="Generated look still: a sunny plaza with a glass tower, lamp post, crates and kiosk"> | [`stage1_genlook_plaza_a40.mp4`](examples/stage1_genlook_plaza_a40.mp4) |

- Layout clip, frame by frame: [contact sheet](examples/layout_plaza_dolly_in_frames.png)
- Render from the generated look still: [contact sheet](examples/stage1_genlook_plaza_frames.png)

<p align="center"><img src="docs/media/three_looks.gif" width="100%" alt="Top left: the grey plaza layout. The other three: LTX-2.5 renders of the same layout and camera move as a sunny day, a rainy night and a snowy dusk."></p>
<p align="center"><sub>One layout, three prompts: same blocking and camera, only the look changes (<code>scripts/three_looks.py</code>).</sub></p>

<p align="center"><img src="docs/media/four_moves.gif" width="100%" alt="Four LTX-2.5 renders of the same grey Blocks layout, each with its layout inset in the corner: an orbit around shipping containers on a foggy harbour, a crane up over brutalist blocks in a desert, a sideways truck past concrete blocks in a neon Tokyo parking lot at night, and a dolly into an abandoned warehouse."></p>
<p align="center"><sub>One layout, four camera moves, four places: orbit, crane up, truck, dolly in, each 97 frames on the A40, with the
grey layout inset (<code>scripts/four_moves.py</code>). Clips:
<a href="examples/stage1_harbour_orbit_a40.mp4">harbour orbit</a>, <a href="examples/stage1_desert_crane_up_a40.mp4">desert crane up</a>,
<a href="examples/stage1_tokyo_truck_a40.mp4">Tokyo truck</a>, <a href="examples/stage1_warehouse_dolly_in_a40.mp4">warehouse dolly in</a>.</sub></p>

- Render from a reference photo instead ([`look_plaza.jpg`](examples/look_plaza.jpg)): [contact sheet](examples/stage1_core_plaza_frames.png)
- A four-shot sequence from **Render all shots** (dolly in, orbit right, crane up, truck right, cut together):
  [`sequence_plaza_4shots_a40.mp4`](examples/sequence_plaza_4shots_a40.mp4), layout cut
  [`sequence_plaza_4shots_layout.mp4`](examples/sequence_plaza_4shots_layout.mp4)
- Stage 2 at 1920×1088, 97 frames: [`two_stage_plaza_1920_a40.mp4`](examples/two_stage_plaza_1920_a40.mp4)
  (look still [`look_gen_plaza_1920_a40.png`](examples/look_gen_plaza_1920_a40.png))
- Stage 1 at 121 frames (5 s): [`stage1_plaza_121f_a40.mp4`](examples/stage1_plaza_121f_a40.mp4)
- The same three looks at full size (1920×1088, 97 frames, stage 1 + stage 2, about 7 minutes each):
  [day](examples/two_stage_day_plaza_1920_a40.mp4), [night](examples/two_stage_night_plaza_1920_a40.mp4),
  [snow](examples/two_stage_snow_plaza_1920_a40.mp4)
- The demo video's scene: the plaza with an added box and person, Orbit right
  ([`demo_scene.json`](examples/demo_scene.json), load it with **Load**), its layout
  [`layout_demo_scene.mp4`](examples/layout_demo_scene.mp4), look still
  [`look_demo_scene_a40.png`](examples/look_demo_scene_a40.png) and render
  [`stage1_demo_scene_a40.mp4`](examples/stage1_demo_scene_a40.mp4)

A look still that names something the layout doesn't have (a clock tower where the layout has sky) puts it
there anyway, and the render follows the still rather than the layout. The same goes for leaving the sky
out: "a glass office tower" alone fills the whole background with glass. Lowering the depth strength
doesn't fix it (by 0.7 the boxes start to drift); describing the shot does. Name the sky where the layout
has sky, and say where the big shapes are ("a tower on the left"). Every **Prompt ideas** entry was
checked that way on an A40 with three seeds. If a still drifts, change the seed or describe what the boxes are.

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

In Windows PowerShell 5.1, which has no `&&`, use `;` instead: `cd web; npm install; npm run dev`.
`npm run build` builds the static page (what GitHub Pages serves) into `web/dist/`.

Open http://localhost:5173, add boxes, people and walls, then turn on **Look through shot camera**,
frame the shot and press **K** to key it on the timeline. Or frame frame 0 and pick a one-click move under
**Apply move**: dolly in/out, truck, crane, orbit or locked off. A scene can hold several **shots** (cameras
over the same blocking): **+ Shot** copies the current one, ↑/↓ set the order of the cut. **Export playblast** renders every frame at
exactly 1/24 s steps to an H.264 MP4 (960×576 or 1920×1088, 65/97/121 frames) plus PNGs of frame 0 and
its depth map (near = white, sky = black).
With the dev server running, exports are also written to `web/exports/`. Scenes save as JSON;
the **Blocks** and **Plaza** presets reproduce `scripts/make_test_layout.py`'s clips.

Tests: `cd web && npm test`. Smoke test of the production build as GitHub Pages serves it (no render
server): `npm run test:e2e` (Playwright; in Chrome the demo clips are also checked to decode).

## Render (Comfy SDK)

`server/` is a small local server that takes the playblast, a look still and a prompt, runs our
stage-1 workflow ([workflows/stage1_layout_api.json](workflows/stage1_layout_api.json), built from
ComfyUI core nodes by `server/workflow.py`; a 1920×1088 playblast also gets stage 2,
[workflows/two_stage_layout_api.json](workflows/two_stage_layout_api.json)) through the official
[Comfy SDK](https://docs.comfy.org/development/api-development/sdks), and returns the clip.
The SDK talks to Comfy Cloud by default, or to any ComfyUI behind
[comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) via `COMFY_BASE_URL`.

Needs Python 3.10+ (the Python that ships with macOS is 3.9: get a newer one from python.org or Homebrew).
Install into a virtual environment: Ubuntu 23.04+ and Homebrew's Python refuse a plain `pip install`.
Commands below are run from the repo root, with the environment active.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r server/requirements.txt
COMFY_API_KEY=comfyui-... python -m server.app                          # Comfy Cloud (paid plan)
python -m server.app --comfy-url http://127.0.0.1:8189                  # your own ComfyUI + comfy-api-proxy
COMFY_API_KEY=<proxy token> python -m server.app --comfy-url https://<pod>-8189.proxy.runpod.net   # RunPod
```

On Windows, in PowerShell (use `py` if `python` isn't found):

```powershell
python -m venv .venv; .venv\Scripts\Activate.ps1     # "running scripts is disabled"? Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r server/requirements.txt
$env:COMFY_API_KEY = "comfyui-..."; python -m server.app                 # env vars are set with $env:
python -m server.app --comfy-url http://127.0.0.1:8189
```

Before spending GPU time, `python -m server.doctor` checks the Python side and the Comfy target, and with
`--comfyui http://127.0.0.1:8188` (ComfyUI itself, not the proxy) that every node and model file our workflows
use is there.

`--cors-origin <origin>` lets a page served from elsewhere (the live link) call the server; `--host 0.0.0.0`
listens beyond localhost (e.g. on a pod, then use its `https://<pod>-8190.proxy.runpod.net` URL).

Then in `web/` (`npm run dev`) press **Render…**, write a one- or two-sentence prompt describing the
finished shot, and press **Generate look still**: the panel exports the playblast (only if the scene
changed), sends frame 0's depth map to our look-still workflow
([workflows/look_still_depth_api.json](workflows/look_still_depth_api.json): Z-Image-Turbo + the Fun
ControlNet Union in depth mode, core nodes only), and shows the still next to frame 0 and its depth.
Because the still is generated from the layout's own depth, it lines up with the playblast box for box,
which is what makes the video render keep both the look and the layout (a still that doesn't match
wins over the layout). Not happy? Change the seed or the prompt and generate again, or press **3 variants** for three seeds at
once: every still stays in a strip under the panel, so you can click back to the one you liked.
**Prompt ideas…** fills in a starter prompt.

**Render all shots** renders a whole scene: for each shot, in order, it exports the playblast, generates its
look still (same prompt and seed for every shot, so they share a look) and renders it, then cuts the renders
together into one sequence, with the layout sequence beside it to compare (`POST /api/stitch`, no re-encode).
Budget about 2.5–4 minutes per 65-frame shot on an A40. While a job runs, the status line names the node
and sampler step, and **Cancel** stops it on the GPU too (`POST /api/render/<id>/cancel`). Then press
**Render shot**. **Choose look still…** still takes your own image instead (same framing as frame 0).

Without the server:

```bash
python -m server.look web/exports/<shot>_depth.png "prompt" -o look.png        # look still (~1 MP, then playblast size)
python -m server.render web/exports/<shot>.mp4 look.png "prompt" -o out.mp4    # the clip (1920×1088: + stage 2; --stage1-only to skip)
python -m server.stitch shot1.mp4 shot2.mp4 shot3.mp4 -o sequence.mp4          # cut renders together
```

No GPU? Run the whole chain against a stand-in ComfyUI that returns the layout as the "render" (and
the depth map as the "look still"):

```bash
python -m server.mock_comfyui --port 8188 &
comfy-api-proxy --comfyui http://127.0.0.1:8188 --port 8189 &
python -m server.app --comfy-url http://127.0.0.1:8189
```

Windows PowerShell 5.1 has no trailing `&`, so start the first two with `Start-Process` (this works in
PowerShell 7 too):

```powershell
Start-Process -NoNewWindow python -ArgumentList "-m server.mock_comfyui --port 8188"
Start-Process -NoNewWindow comfy-api-proxy -ArgumentList "--comfyui http://127.0.0.1:8188 --port 8189"
python -m server.app --comfy-url http://127.0.0.1:8189
```

Then, from a second terminal in the repo root, send the plaza example through it (each job takes a few
seconds against the mock). In PowerShell type `curl.exe`: plain `curl` is an alias for `Invoke-WebRequest`.

```bash
curl -F depth=@examples/layout_plaza_dolly_in_depth.png -F "prompt=a sunlit plaza" -F width=960 -F height=576 http://127.0.0.1:8190/api/look
curl http://127.0.0.1:8190/api/look/<id>               # repeat until "status": "succeeded"
curl -o look.png http://127.0.0.1:8190/api/look/<id>/image
curl -F layout=@examples/layout_plaza_dolly_in.mp4 -F look=@look.png -F "prompt=a sunlit plaza" -F width=960 -F height=576 -F frames=65 http://127.0.0.1:8190/api/render
curl http://127.0.0.1:8190/api/render/<id>             # "succeeded", then:
curl -o out.mp4 http://127.0.0.1:8190/api/render/<id>/video
```

Against the mock, `out.mp4` is the layout clip itself. A weekly check runs exactly these steps on clean
Linux, macOS and Windows machines ([install.yml](.github/workflows/install.yml)).

Tests: `python -m unittest discover -s server/tests -t .` (the end-to-end ones start the mock and the proxy).

## Try the pipeline now

Make a test layout clip locally (needs Python with numpy, and ffmpeg or `pip install imageio-ffmpeg`):

```bash
pip install -r requirements.txt
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
