# Writeup (for the submission form)

Final text for the [form](https://form.typeform.com/to/V1dSQrkS) and the social posts. Every claim here
matches the README; if the README changes, change this too. On the night, replace `<NAME>` with the
picked name ([NAMES.md](NAMES.md)) and fill in `<live link>` and `<video link>`.

The field headings below are what we expect the form to ask; paste each answer into the closest field.

## Project name

<NAME>

## One line

Block a person walking, get a person walking: key grey stand-ins and a camera move in your browser, and
get back a cinematic clip that follows that exact blocking, move and camera. Open weights only: LTX-2.5 +
Layout-to-Render, through the Comfy SDK.

## Description (about 150 words)

<NAME> is previs that turns into the final shot: block a person walking, get a person walking. In a
browser editor you place grey boxes, people and walls, key them to move, and key a camera or pick a
move (dolly, truck, crane, orbit). The browser exports a playblast and frame 0's depth map.
Z-Image-Turbo with a depth ControlNet paints a first frame from that depth, so it lines up box for box.
Then LTX-2.5 with the Layout-to-Render IC-LoRA films the shot: camera, blocking and walk follow the
layout, and the look comes from that frame. Shots render at 960×576 (up to 5 s) or 1920×1088 with a
refine stage, and **Render all shots** cuts several into a sequence. Change the prompt, not the shot:
one layout renders as a sunny day, a rainy night or a snowy dusk. Share a scene as a link, or render
from the live page with your own Comfy key.

## Prize categories

Open Weights Only, and the bonus VFX Workflow Built with LTX.

## Why it fits VFX Workflow Built with LTX

- LTX-2.5 is the core video model: every clip is LTX-2.5 + the Layout-to-Render IC-LoRA.
- It is a VFX and previs workflow: block, playblast, art-direct, render, cut. The artist sets the
  camera, the layout and how the stand-ins move; the model doesn't get to improvise them. A person
  stand-in keyed to walk across the plaza under an orbit comes back as a woman walking the same path,
  step for step (`docs/media/walk.gif`).
- Our own workflows, built from ComfyUI core nodes by `server/workflow.py` and checked in CI, are in
  [workflows/](../../workflows/): stage 1 (960×576), two-stage (1920×1088: x2 latent upscale and 3
  refine steps) and the depth-matched look still.
- Real output on an A40: the walk (97 frames, orbit right); one layout with four camera moves in
  four places (orbit on a foggy harbour, crane up in a desert, truck through neon Tokyo, dolly into a
  warehouse; `docs/media/four_moves.gif`); three looks of the same plaza blocking, also as 1920×1088
  finals; and a four-shot sequence from **Render all shots**. Stage 1 takes about 2.5–4 minutes per
  65-frame shot and 121 frames (5 s) in about 4 minutes; stage 2 at 1920×1088 (97 frames) about 6.
- Prompts are part of the workflow: every **Prompt ideas** entry was checked on an A40 with three
  seeds to keep the layout, and reworded where it drifted (name the sky where the layout has sky, and
  say where the big shapes are).

## Why it fits Open Weights Only

- Every model downloads from Hugging Face and runs locally: LTX-2.5 and the IC-LoRA (LTX-2.x
  community licence) and Z-Image-Turbo with the Fun ControlNet Union (Apache-2.0).
  Full list: [LICENCE_AUDIT.md](LICENCE_AUDIT.md).
- No partner nodes or paid APIs. `scripts/check_open_weights.py` checks every workflow in CI.
- The app talks to ComfyUI through the official Comfy SDK, on Comfy Cloud or on your own GPU
  (self-hosted ComfyUI behind comfy-api-proxy). We developed and rendered on a rented A40.

## How it uses the Comfy SDK

`server/` runs every job (look still, render, stage 2) through `comfy-sdk`'s `AsyncComfy`. The browser
shows progress by node and sampler step, and **Cancel** stops a job on the GPU too. The browser app is
the standalone app; the render server is one command (`python -m server.app`), and
`python -m server.doctor` checks the setup before you spend GPU time. On the live page, **Render…**
also takes your own Comfy key instead of a server URL and runs the same committed workflows over the
Comfy API the SDK speaks (see `docs/LIVE_RENDER.md`).

## Links

- Live link: <live link> (https://colinwww.github.io/open-cinema-studio/ until a rename). It opens with
  a step-by-step replay of a real A40 render of the plaza example (no GPU needed), then the full
  blocking tool. **Share link** copies a URL that opens your scene, and the page shows a preview card
  when the link is posted. Use Chrome or Edge.
- Repo: https://github.com/ColinWWW/open-cinema-studio (MIT). Run-locally steps are in the README.
- Demo video: <video link>
- Social post: link to the X/Bluesky post once it's up.

## Social posts

All tagged #OpenSourceHiggsfield. Attach the demo video natively where the platform allows it, and
also give `<video link>` for anyone who wants the full-length version.

### X / Bluesky

240 characters as written. On X each link counts as 23, so with both links and a name of up to 20
letters it stays under 280. Bluesky (300 limit) counts a link at its full length: attach the video
there and drop the "Video:" line.

> Block a person walking, get a person walking. Key grey stand-ins and a camera in your browser;
> LTX-2.5 + Layout-to-Render films it.
> <NAME>: open weights only, on the Comfy SDK.
>
> Try it: <live link>
> Video: <video link>
>
> #OpenSourceHiggsfield

### LinkedIn (about 100 words)

> Directors block shots with stand-ins before they light them. I built <NAME> to do the same with
> video models.
>
> Block a person walking, get a person walking. You place grey boxes and people in a browser editor,
> key them to move, and key a camera move. The app exports a playblast and its depth map,
> Z-Image-Turbo paints a matching first frame, and LTX-2.5 with the Layout-to-Render IC-LoRA films the
> shot, following your exact camera, layout and walk. Several shots render and cut into one sequence,
> and the same blocking can take any look.
>
> Open weights only, built on the Comfy SDK, MIT licensed. My entry to Comfy's Open Source Higgsfield
> challenge.
>
> Try it: <live link>
> Demo: <video link>
>
> #OpenSourceHiggsfield #ComfyUI #LTX #previs #VFX

### Reddit r/comfyui

**Title:** <NAME>: block a person walking with grey stand-ins in the browser, LTX-2.5 Layout-to-Render films a person walking (open weights, Comfy SDK)

> I built a previs tool for the Open Source Higgsfield challenge (#OpenSourceHiggsfield). You block a
> scene in a three.js editor (grey boxes, people, walls), key stand-ins to move along the shot, key a
> camera or pick a move (dolly, truck, crane, orbit), and export a playblast plus frame 0's depth map
> from the browser. A person stand-in keyed to walk across a plaza under an orbit comes back as a woman
> walking the same path, step for step.
>
> Z-Image-Turbo with the Fun ControlNet Union (depth) turns that depth map into a look still that
> lines up box for box. Then LTX-2.5 with the Layout-to-Render IC-LoRA renders the clip from the
> playblast and the still. Stage 1 is 960×576 (up to 121 frames); stage 2 goes to 1920×1088 with a
> latent upscale and 3 refine steps.
>
> Everything is core nodes, workflows are in the repo, and the server drives ComfyUI through the
> Comfy SDK (Comfy Cloud or your own GPU via comfy-api-proxy); the live page can also render with
> your own Comfy key. On an A40: about 2.5–4 min per 65-frame shot, about 6 min for 1920×1088. Same
> layout, four moves, four places (harbour orbit, desert crane, Tokyo truck, warehouse dolly) is in the
> README.
>
> Live demo: <live link> · Video: <video link> · Repo: https://github.com/ColinWWW/open-cinema-studio
