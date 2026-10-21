# Writeup (for the submission form)

Draft text for the form and the social post. Keep the claims in step with the README and
[CHECKLIST.md](CHECKLIST.md); swap in the name once it's picked.

## One line

Block a shot with grey boxes and a camera move in your browser, and get back a cinematic clip that
follows that exact camera and layout, using open weights only (LTX-2.5 + Layout-to-Render through the Comfy SDK).

## What it is (about 150 words)

Open Cinema Studio is previsualisation that turns into the final shot. You block a scene in a
three.js editor in the browser: grey boxes, people and walls, and a keyframed shot camera or a
one-click move (dolly, truck, crane, orbit). The app exports an on-spec playblast and frame 0's
depth map right in the browser. Z-Image-Turbo with a depth ControlNet paints a finished first frame
from that depth, so it lines up with the layout box for box. Then LTX-2.5 with the Layout-to-Render
IC-LoRA films the shot: it follows the layout's camera and blocking and takes its look from that
frame. A scene can hold several shots, and **Render all shots** renders them in order and cuts them
into a sequence. Change the prompt, not the shot: the same blocking renders as a sunny day, a rainy
night or a snowy dusk.

## Why it fits VFX Workflow Built with LTX

- LTX-2.5 is the core video model: every clip is LTX-2.5 + the Layout-to-Render IC-LoRA.
- It is a VFX and previs workflow: block, playblast, art-direct, render, cut. The camera and layout
  are set by the artist, not left to the model.
- Our own stage-1 workflow, built from ComfyUI core nodes by `server/workflow.py` and checked in CI,
  is in [workflows/](../../workflows/).

## Why it fits Open Weights Only

- Every model downloads from Hugging Face and runs locally: LTX-2.5 and the IC-LoRA (LTX-2.x
  community licence) and Z-Image-Turbo with the Fun ControlNet Union (Apache-2.0).
  Full list: [LICENCE_AUDIT.md](LICENCE_AUDIT.md).
- No partner nodes or paid APIs. `scripts/check_open_weights.py` checks every workflow in CI.
- The app talks to ComfyUI through the official Comfy SDK, on Comfy Cloud or on your own GPU
  (self-hosted ComfyUI behind comfy-api-proxy). We developed and rendered on a rented A40.

## Built with the Comfy SDK

`server/` runs every job (look still, render) through `comfy-sdk`'s `AsyncComfy`, with progress
reported back to the browser. The browser app is the standalone app; the render server is a small
local process you start with one command.

## Try it

- Live link: https://colinwww.github.io/open-cinema-studio/ opens with a replay of a real A40
  render of the plaza example, step by step (no GPU needed), then the editor.
- Repo: https://github.com/ColinWWW/open-cinema-studio (MIT). Run-locally steps are in the README.

## Social post (under 280 characters)

> Block a shot with grey boxes in your browser. Get back a cinematic clip that moves exactly like it.
> LTX-2.5 + Layout-to-Render, open weights only, built on the Comfy SDK. Try it: <live link>
> #OpenSourceHiggsfield
