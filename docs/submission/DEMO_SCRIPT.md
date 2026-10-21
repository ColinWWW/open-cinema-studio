# Demo video: shot list (2:00 max)

One idea, shown fast: **you direct the camera, the model films it.** Screen recordings from the
live page (Chrome, 1920×1080), voice-over or captions. Times are targets.

| Time | Shot | On screen | Say / caption |
|---|---|---|---|
| 0:00–0:08 | Hook | The hero side by side: grey plaza dolly-in, then the photoreal render moving the same way | "Block a shot with grey boxes. Get back a cinematic clip that moves exactly like it. Open weights only." |
| 0:08–0:30 | Block | Empty scene → add boxes and a person → move and scale them → turn on *Look through shot camera* → frame → **Apply move: Orbit right** → Space to play | "A three.js blocking tool in the browser: place stand-ins, frame the shot, key the camera or pick a move." |
| 0:30–0:40 | Playblast | **Export playblast**: the progress bar, then the MP4, frame 0 and the depth map | "It exports an on-spec layout clip and frame 0's depth, right in the browser." |
| 0:40–1:00 | Art-direct | Render panel: **Prompt ideas…** → **3 variants** → the strip fills → click the best | "Z-Image-Turbo with a depth ControlNet paints the first frame from the layout's own depth, so it lines up box for box." |
| 1:00–1:25 | Render | **Render shot** → progress → playblast and render playing side by side | "LTX-2.5 with the Layout-to-Render IC-LoRA follows the layout's camera and blocking and takes the look from that frame." |
| 1:25–1:45 | Same blocking, any look | The 3-way comparison: one layout, three renders (e.g. sunny day, rainy night, snowy dusk), in a grid | "Same blocking, three looks. Change the prompt, not the shot." |
| 1:45–2:00 | How it's built | The README: Comfy SDK, our core-node workflows, the open-weights check, the live link | "Built on the Comfy SDK with our own core-node workflows, on Comfy Cloud or your own GPU. MIT licensed. Try it at the link." |

## To record beforehand

- The 3-way comparison (three prompts on one layout): needs GPU time, see PLAN §7
- A clean render of a scene blocked on camera (the 0:08 shot), so the render at 1:00 is of that scene
- Keep the real render waits out of the video: cut from "Render shot" to the result, and say how long it took (~3 min on an A40)
