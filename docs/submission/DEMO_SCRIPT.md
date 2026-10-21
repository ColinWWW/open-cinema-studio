# Demo video: shot list (2:00 max)

One idea, shown fast: **you direct the camera, the model films it.** Screen recordings from the
live page (Chrome, 1920×1080), voice-over or captions. Times are targets.

| Time | Shot | On screen | Say / caption |
|---|---|---|---|
| 0:00–0:08 | Hook | The hero side by side: grey plaza dolly-in, then the photoreal render moving the same way | "Block a shot with grey boxes. Get back a cinematic clip that moves exactly like it. Open weights only." |
| 0:08–0:30 | Block | Empty scene → add boxes and a person → move and scale them → turn on *Look through shot camera* → frame → **Apply move: Orbit right** → Space to play | "A three.js blocking tool in the browser: place stand-ins, frame the shot, key the camera or pick a move." |
| 0:30–0:40 | Playblast | **Export playblast**: the progress bar, then the MP4, frame 0 and the depth map | "It exports an on-spec layout clip and frame 0's depth, right in the browser." |
| 0:40–1:00 | Art-direct | Render panel: **Prompt ideas…** → **3 variants** → the strip fills → click the best | "Z-Image-Turbo with a depth ControlNet paints the first frame from the layout's own depth, so it lines up box for box." |
| 1:00–1:15 | Render | **Render shot** → progress → playblast and render playing side by side | "LTX-2.5 with the Layout-to-Render IC-LoRA follows the layout's camera and blocking and takes the look from that frame." |
| 1:15–1:30 | A scene, not a clip | Shot list with 3 shots (wide dolly-in, orbit, crane up) → **Render all shots** → the cut sequence playing beside its layout sequence | "Add shots, order the cut, render the whole scene: one blocking, several cameras, one sequence." |
| 1:30–1:45 | Same blocking, any look | The 3-way comparison: one layout, three renders (e.g. sunny day, rainy night, snowy dusk), in a grid | "Same blocking, three looks. Change the prompt, not the shot." |
| 1:45–2:00 | How it's built | The README: Comfy SDK, our core-node workflows, the open-weights check, the live link | "Built on the Comfy SDK with our own core-node workflows, on Comfy Cloud or your own GPU. MIT licensed. Try it at the link." |

## To record beforehand

- ✅ The 3-way comparison: `examples/three_looks_plaza.mp4` (960×576), and full size as
  `examples/two_stage_{day,night,snow}_plaza_1920_a40.mp4` (Oct 21)
- ✅ A plaza sequence with **Render all shots**: `examples/sequence_plaza_4shots_a40.mp4` and its layout cut (Oct 21)
- ✅ A render of the scene blocked on camera (the 0:08 shot: plaza + a box and a person, Orbit right), so the
  render at 1:00 is of that scene: `examples/stage1_demo_scene_a40.mp4`, from `examples/demo_scene.json` and
  `examples/look_demo_scene_a40.png` (Oct 21). Its prompt names the person ("a woman in a red coat standing by
  stacked wooden crates"); without that, the stand-in renders as a post.
- Keep the real render waits out of the video: cut from "Render shot" to the result, and say how long it took (~3 min on an A40)
