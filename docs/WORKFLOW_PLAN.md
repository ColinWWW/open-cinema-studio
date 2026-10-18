# Reshoot — ComfyUI Workflow Plan

**Goal:** take any clip and re-film it from a new camera position (orbit, crane, dolly, truck),
using open-weights models only. Targets: **Open Weights Only** (main) + **VFX Workflow Built with LTX** (bonus).

Deadline: **Oct 30, 2026, 9am PT**. Submit a working app, an open-source repo, and a demo video.

---

## 1. Core idea: geometry first, then generation

Asking a video model to "move the camera" from a text prompt alone gives you a random move.
Reshoot instead **computes the new viewpoint with real 3D geometry**, then uses LTX to fill in
everything the original camera never saw.

```
source clip ──► per-frame depth ──► 3D point cloud ──► re-render from new camera path
                                                          │
                                       ┌──────────────────┼──────────────────┐
                                       ▼                  ▼                  ▼
                                 warped RGB         warped depth       hole mask
                                 (with holes)       (new viewpoint)    (unseen areas)
                                       │                  │                  │
                                       └────────► LTX (open weights) ◄───────┘
                                                          │
                                                  re-shot clip (+ audio passthrough)
```

The warp step lives in our custom node pack (`custom_nodes/comfyui-reshoot`). It is the novel
part of the entry and something the judges can inspect.

## 2. Model list (all open weights)

| Stage | Model | License | Notes |
|---|---|---|---|
| Video generation | **LTX-2** (Lightricks) | LTX open-weights license | Core model. This is what qualifies us for the LTX bonus. |
| Structure control | LTX IC-LoRA: depth | same | Guides LTX with our warped depth video. |
| Depth estimation | Depth Anything V2 **Small** | Apache-2.0 | Base/Large are CC-BY-NC. Use Small to keep licensing clean. Video Depth Anything Small (Apache-2.0) is the upgrade if per-frame depth flickers. |
| Text encoder | Whatever LTX-2 ships with | per model card | Do **not** swap in an API-based prompt enhancer. |
| Optional first-frame cleanup | LTX itself (image-to-video with the first frame) | — | Keep the model count small. |

**Compliance rules (Open Weights Only):**
- No partner/API nodes anywhere in the graph (no `Comfy API` nodes, no hosted LLM prompt enhancers).
- No closed models in the app either (e.g. no GPT captioning in the web UI).
- List every model + license in the README. Judges will check.

> ⚠️ Check exact LTX-2 checkpoint names, IC-LoRA file names and node class names on the pod on
> Day 1. The ComfyUI LTX nodes have changed between versions, so this plan names the
> *role* of each node. Pin the real class names in `workflows/reshoot_api.json` once it runs.

## 3. Graph, stage by stage

### Stage A — Load and normalize
1. **Load Video** (core `LoadVideo` or VHS `VHS_LoadVideo`) — title it `RESHOOT_INPUT_VIDEO`.
2. **Reshoot Fit for LTX** (ours) — trims to `8n+1` frames and resizes to multiples of 32.
   Start at **768×512 (or 512×768), 97 frames** for development and scale up for final renders.
3. Pass the audio straight through to the final save node. A re-shot clip with its original
   audio makes a much better demo.

### Stage B — Depth
4. **Depth Anything V2 (Small)** on all frames → depth IMAGE batch (near = bright).
   Node pack: `kijai/ComfyUI-DepthAnythingV2`.

### Stage C — New camera (ours)
5. **Reshoot Camera Move** — preset or custom: `orbit_deg`, `crane_deg`, `dolly`, `truck`,
   `pedestal`, mode `ramp` (eases from the original view to the target) or `constant`
   (the whole clip is shot from the new position). Title it `RESHOOT_CAMERA`.
6. **Reshoot Depth Warp** — inputs: frames, depth, camera. Outputs:
   - `warped` — the clip re-rendered from the new viewpoint, with holes
   - `warped_depth` — depth from the new viewpoint, with holes filled from the background
   - `holes` — mask of everything the original camera never saw (grown a little)

### Stage D — Generation with LTX (pick on Day 2)

**Path 1 — geometry-guided regeneration (primary)**
- LTX-2 text-to-video / image-to-video sampler, with:
  - **depth IC-LoRA** loaded, guide video = `warped_depth` (fixes geometry + camera motion)
  - **first-frame image condition** = `warped[0]` (fixes appearance). Its holes are small when
    mode = `ramp`, because frame 0 is the original view.
  - prompt = user prompt or an auto-description of the clip, written by the user (no API captioner)
- Strength: depth guide ~0.8–1.0, first frame 1.0.
- Pros: clean, temporally stable output. Cons: fine texture can drift from the source over long moves.

**Path 2 — warp + refine (fallback / "faithful" mode)**
- VAE-encode `warped`, apply `holes` as a latent noise mask, and run LTX video-to-video at
  partial denoise (~0.5–0.7) so known pixels are kept and holes are generated.
- Pros: keeps the source's exact look. Cons: warp artefacts can show through at low denoise.

**Day 2 spike:** run the same 3 test clips through both paths. Keep the winner as the default
and expose the other as a "Faithful / Creative" toggle in the app.

### Stage E — Output
7. Optional: LTX spatial/temporal upscaler (if shipped open) for the final render.
8. **Save Video** with the original audio → title it `RESHOOT_OUTPUT`.
9. Also save a **side-by-side** (source | warp preview | result). This sells the demo video.

## 4. App ↔ ComfyUI contract

The web app (`app/`) loads `workflows/reshoot_api.json` (API format, exported from ComfyUI with
*Save (API)*) and patches inputs by **node title**:

| Node title | Inputs the app sets |
|---|---|
| `RESHOOT_INPUT_VIDEO` | `video` / `file` (uploaded filename) |
| `RESHOOT_CAMERA` | `preset`, `orbit_deg`, `crane_deg`, `dolly`, `truck`, `pedestal`, `mode` |
| `RESHOOT_PROMPT` | `text` |
| `RESHOOT_SAMPLER` | `seed` (`noise_seed`), `steps` |
| `RESHOOT_OUTPUT` | — (the app downloads whatever this node saves) |

Keep these titles stable and the app never needs to know the rest of the graph.

## 5. Schedule (12 days)

| Day | Date | Work |
|---|---|---|
| 1 | Oct 18 | Pod up, update ComfyUI, download models, get stock LTX-2 i2v + depth IC-LoRA running. |
| 2 | Oct 19 | Install `comfyui-reshoot`, check warp output on 3 clips, Path 1 vs Path 2 spike. |
| 3–4 | Oct 20–21 | Finish the full graph, export `reshoot_api.json`, wire up the app end to end. |
| 5–6 | Oct 22–23 | Quality: depth smoothing, hole handling, prompt defaults, presets that look cinematic. |
| 7 | Oct 24 | Multi-shot mode: one clip → 3 angles (wide / orbit / crane) side by side. Strong demo hook. |
| 8 | Oct 25 | Make the app public (see §6), share with a few people, fix what breaks. |
| 9–10 | Oct 26–27 | Build a showcase reel: 6–8 clips, before/after. |
| 11 | Oct 28 | Demo video (show app + explain the geometry pipeline). Optional SF Build Night. |
| 12 | Oct 29 | README, licenses, setup steps tested on a fresh pod. **Submit early** (deadline Oct 30, 9am PT). |

## 6. Open questions to settle early
- **"Comfy Developer Platform"** — check the entry form for exactly what counts as a working app
  (published Comfy app/workflow vs. any hosted UI). The Gradio app is a fallback either way.
- **Public hosting** — a RunPod pod is not a public app. Options: a RunPod serverless endpoint
  running ComfyUI, or Comfy's own hosting if the platform provides it.
- **GPU** — A40 is fine for development. LTX-2 FP8 checkpoints get no FP8 speed-up on Ampere,
  so use H100 for final renders and the demo reel.
