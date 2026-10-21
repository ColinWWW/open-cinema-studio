# Open Cinema Studio — Plan

> Updated Oct 21, 2026. Owner: Colin (solo, ~30–50 build hours total).
> Earlier concept ("Reshoot", depth-warp re-filming) was dropped in favour of this. It's still in git history.

## 1. Competition

Comfy **Open Source Higgsfield**: https://comfy.org/open-source-higgsfield
Rules: https://blog.comfy.org/p/higgsfield-promised-to-open-source · Submit: https://form.typeform.com/to/V1dSQrkS

- **Deadline: Fri Oct 30, 9:00am PT. Submit the night of Oct 29.** Winners Nov 6.
- **Deliverables:** GitHub repo (code, workflow, OSS license, run-locally instructions) · demo video ≤ 2 min ·
  social post with the demo, tagged **#OpenSourceHiggsfield** · a live link to try it (optional, but
  **strongly encouraged**; see §2.6).
- **Must be built using the Comfy SDK** (Comfy Router / Comfy API use encouraged), as a **standalone app**
  someone else can open and use, not a ComfyUI workflow. Check https://docs.comfy.org for current usage.
  Don't guess the API.
- Lawful, SFW, no unlicensed IP or likenesses. One submission per person.

**Targets:** **Open Weights Only** (RTX 5090: no partner nodes or APIs, open-weights models only) +
**VFX Workflow Built with LTX** ($2,000, LTX is the core video model).
Honest odds: ~5% for the 5090, 15–25% for *some* prize. The repo is the guaranteed payoff.

**Comfy Discord answers (Discord: https://discord.com/invite/comfyorg):**
- *Official welcome post (Deep Mehta, Oct 16):* standalone app, built using the Comfy SDK (Router/API
  encouraged), any models open or closed, public repo with an OSS license, live link strongly encouraged.
- *Open weights (guill, Comfy team, Oct 16):* revenue-capped / non-commercial weights like LTX-2.5
  **qualify**. All that matters is that the models can be downloaded and run locally. Note in the README
  that commercial use needs commercial licenses (done).
- *Platform + open weights (Deep Mehta, to another entrant):* an app calling **Comfy Cloud through the
  official SDK/API with its own workflow files in the repo** counts; an open-weights LoRA imported from
  Hugging Face into Cloud is fine; small local preprocessing is fine. Open weights = **no partner nodes**
  (paid external API nodes).

**Decided (Oct 21):** a **self-hosted** ComfyUI (rented GPU) driven through the SDK counts. Colin's call,
not yet confirmed by Comfy: the server uses the official `comfy-sdk` either way (self-hosted via
`comfy-api-proxy`), and open weights means "can be downloaded and run locally" (guill). Confirmation
asked on Discord; until it comes, keep the README showing both targets (Comfy Cloud first, self-hosted second).

**Decided (Oct 21):** one entry can win multiple prizes (per Colin), so the Open Weights Only prize and
the LTX bonus are both in play.

SF Build Night Oct 28 (https://luma.com/5mydmvu6): for debugging with the Comfy team, not for building.

## 2. Concept: open "Cinema Studio" with real shot blocking

1. **Browser blocking tool (three.js):** drop grey primitives (box, capsule-person, plane), place them, keyframe a camera.
2. **Playblast export:** render the grey scene to a clip at the exact specs in §3.
3. **Art-direction frame:** the look of frame 1. **A: user uploads an image** (start here).
   B: generate it with an open-weights image model from the clay frame (only if ahead of schedule).
4. **Render:** layout clip + first frame + short prompt → ComfyUI running **LTX-2.5 + Layout-to-Render IC-LoRA**.
5. **Demo hook:** one blocked scene rendered three ways (different first frames/prompts), side by side.
6. **Live link at $0 hosting cost:** the blocking tool is fully client-side (WebCodecs export), so host
   `web/` as a static site on **GitHub Pages**. **Render** calls Comfy Cloud through the Comfy SDK with the
   **visitor's own Comfy API key** (entered in the page, kept in their browser only, never sent to us),
   so each visitor's renders bill their own account. Without a key, the page still blocks and exports
   playblasts, and shows the example renders. **Unverified:** whether the Comfy SDK/Cloud API can be
   called from a browser (CORS, key handling). If not, a tiny free-tier proxy (e.g. a Cloudflare Worker)
   passes requests through without storing keys.

**Scope discipline:** ~5 primitives + 3 camera keyframes that work every time beat a full 3D editor.
One-command setup + a clear README beats features. **No partner API nodes anywhere.**

## 3. Model pipeline (checked against the model card)

- LoRA: https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render · base: https://huggingface.co/Lightricks/LTX-2.5
- Nodes: https://github.com/Lightricks/ComfyUI-LTXVideo · License: LTX-2.x community license (our code is MIT).
- **Both repos are gated:** click "Agree and Access" on both, create an HF Read token. Never paste it in chat.
- Files and download: `scripts/setup_pod.sh` (int8 variants, ~42 GB; Ampere has hardware int8).
  The official workflow references bf16 filenames, so switch each loader to the int8 files.

**Layout clip specs (the exporter must hit these exactly):**
- **24 fps** (output fps follows the layout clip)
- **width and height divisible by 64**: 960×576 or 960×512 for tests, 1920×1088 for finals
- **8k+1 frames**: 65 ≈ 2.7 s, 97 ≈ 4 s, 121 ≈ 5 s
- grey clay or blocky playblast both work

**Settings:** LoRA 1.0 · CFG 1 · `euler_ancestral` · seed 42 · stage 1 960×544 / 8 steps · stage 2 1920×1088 / 3 steps.
First frame at temporal position -1; mid/last keyframes help hold the look.
Prompt: 1–2 sentences describing the finished shot. **Never say "clay", "3D" or "Unreal".**
**On the A40, run stage 1 only** until it works. Stage 2 is where OOM/slowness will show up.

**Exporter:** no MediaRecorder (real-time, jittery). Step the animation exactly 1/24 s per frame,
grab each canvas frame, encode with ffmpeg (server) or ffmpeg.wasm. `scripts/make_test_layout.py`
is the reference for the output format.

## 4. Infrastructure (RunPod)

- **Volume:** `pretty_gray_bonobo` (v1gig810kp), CA-MTL-1, 100 GB, $14/mo. Grows live, never shrinks.
  RunPod confirms 100 GB; `setup_pod.sh` checks `df` anyway.
- **Template:** ComfyUI – CUDA 12.8 (`runpod/comfyui:1.3.3-comfyuiv0.30.0-cuda12.8`). ComfyUI at
  `/workspace/runpod-slim/ComfyUI`; ports 8188 ComfyUI · 8888 Jupyter · 8080 FileBrowser · 22 SSH.
- **GPU:** A40 48 GB, ~$0.61/hr all-in. **No CPU pods exist in CA-MTL-1**, so setup runs on the A40 too.
- **Security:** set `JUPYTER_PASSWORD` via Set overrides; change the FileBrowser default password or don't expose 8080; enable MFA.
- **RunPod MCP** is installed in Claude Code. Every pod creation needs Colin's explicit yes, with the price stated.
- **Terminate, don't stop** pods (stopped pods still bill disk). `scripts/idle_shutdown.sh` does this automatically.

**Pod steps:** deploy A40 on the volume → Jupyter terminal → clone repo → start the idle guard →
`bash scripts/setup_pod.sh` → restart ComfyUI → load workflow → stage-1 render of `examples/layout_dolly_in.mp4`.

## 5. Repo layout

```
web/          three.js blocking tool (Vite): primitives, camera keys, deterministic playblast export   [after go/no-go]
server/       thin backend: layout + first frame + prompt -> ComfyUI via the Comfy SDK; comfy_client.py is the start
workflows/    the API-format workflow we actually run
scripts/      setup_pod.sh · make_test_layout.py · idle_shutdown.sh · check_open_weights.py
examples/     layout clips, first frames, renders
```

## 6. Schedule (~11.5 days)

| When | Goal |
|---|---|
| **Sun Oct 18** | **GO/NO-GO:** pod up, models in, one stage-1 render from `layout_dolly_in.mp4` + a real first frame. Bad output → pivot now. |
| Oct 19–22 | three.js tool: primitives, transforms, camera keys, exact playblast export (all local, $0) |
| Oct 23–25 | Wire to ComfyUI **via the Comfy SDK** (Comfy Cloud first): upload, queue, poll, return clip |
| Oct 26 | Live link: `web/` on GitHub Pages + bring-your-own Comfy key render (§2.6). First-frame option B only if ahead. |
| Oct 27 | Example outputs, README, setup script tested on a clean pod |
| Oct 28 | SF Build Night: debug/polish |
| **Oct 29** | Demo video (< 2 min, incl. the 3-way side by side), social post, **submit** |
| Oct 30 | Confirm submission, download outputs, **delete the volume** |

## 7. Budget: $29.12 hard limit

Prepaid. If the balance hits $0, RunPod shuts pods down and can **delete the volume**, so never run it down.

| Item | Cost |
|---|---|
| Volume, Oct 18–30 (12 days × $0.47) | $5.60 |
| A40, 22 planned hours × $0.61 | $13.40 |
| A40 slack, ~11 hours | $6.70 |
| **Buffer, never spend** | **$3.40** |

| Phase | A40 hours |
|---|---|
| Go/no-go incl. setup + downloads | 2 |
| Integration (Oct 23–25) | 8 |
| Example outputs (Oct 26–27) | 8 |
| Clean-pod setup test | 1 |
| Demo recording | 3 |

**Rules**
1. Everything except LTX runs on the laptop: three.js tool, exporter, server, README. Free.
2. Every GPU pod starts `idle_shutdown.sh` first (20 min idle / 4 h cap → terminate).
3. Tests at 960×576 / 65 frames, stage 1 only. Full 1920×1088 two-stage renders only for final examples.
4. **No A100/H100**, and no paid always-on demo link. The live link is static hosting + the visitor's own
   Comfy key (§2.6), so it costs us nothing. Use Comfy's free signup credits for our own Cloud testing if they cover it.
5. Check the balance daily. At **$9 left**, stop GPU work: the volume needs ~$5.60 to reach Oct 30, plus the buffer.
6. Delete the volume on Oct 30 after confirming the submission. Don't keep it until Nov 6.

## 8. Tooling notes
- Free OpenCode models are fine for boilerplate. Keep model choice, workflow design and the exporter's correctness with the primary agent.
- REA (reverse-engineering Higgsfield's frontend) was rejected: likely against their ToS, and the contest requires lawful entries.
