# Demo video: shot list (2:00 max)

One idea, shown fast: **you direct the camera, the model films it.** Screen recordings from the
live page (Chrome, 1920×1080), voice-over or captions. Times are targets.

| Time | Shot | On screen | Say / caption |
|---|---|---|---|
| 0:00–0:08 | Hook | The hero side by side: grey plaza dolly-in, then the photoreal render moving the same way | "Block a shot with grey boxes. Get back a cinematic clip that moves exactly like it. Open weights only." |
| 0:08–0:28 | Block | Empty scene → add boxes and a person → move and scale them → turn on *Look through shot camera* → frame → **Apply move: Orbit right** → Space to play | "A three.js blocking tool in the browser: place stand-ins, frame the shot, key the camera or pick a move." |
| 0:28–0:43 | Stand-ins can move | Select the person → **◆ Key move** → last frame → move it in the inspector → Space: it walks while the camera orbits. Then the walk layout beside its render (`layout_plaza_walk_orbit.mp4` ∣ `stage1_walk_orbit_a40.mp4`) | "Stand-ins can move: key the person, move it on the last frame, and it walks. Block a person walking, get a person walking." |
| 0:43–0:51 | Playblast | **Export playblast**: the progress bar, then the MP4, frame 0 and the depth map | "It exports an on-spec layout clip and frame 0's depth, right in the browser." |
| 0:51–1:07 | Art-direct | Render panel: **Prompt ideas…** → **3 variants** → the strip fills → click the best | "Z-Image-Turbo with a depth ControlNet paints the first frame from the layout's own depth, so it lines up box for box." |
| 1:07–1:19 | Render | **Render shot** → progress → playblast and render playing side by side, then stage 2 at 1920×1088 | "LTX-2.5 with the Layout-to-Render IC-LoRA follows the layout's camera and blocking and takes the look from that frame." |
| 1:19–1:32 | Four moves, four places | `four_moves.mp4`: a 2×2 grid of orbit, crane up, truck and dolly in, each render with its grey layout inset | "Four camera moves in four places. Each render follows its grey layout." |
| 1:32–1:45 | Same blocking, any look | The 3-way comparison: one layout, three renders (e.g. sunny day, rainy night, snowy dusk), in a grid | "Same blocking, three looks. Change the prompt, not the shot." |
| 1:45–2:00 | How it's built | The README: Comfy SDK, our core-node workflows, the open-weights check, the live link | "Built on the Comfy SDK with our own core-node workflows, on Comfy Cloud or your own GPU. MIT licensed. Try it at the link." |

## To record beforehand

- ✅ The 3-way comparison: `examples/three_looks_plaza.mp4` (960×576), and full size as
  `examples/two_stage_{day,night,snow}_plaza_1920_a40.mp4` (Oct 21)
- ✅ A walking stand-in: `examples/layout_plaza_walk_orbit.mp4` and its render `examples/stage1_walk_orbit_a40.mp4`,
  from `examples/walk_scene.json` (Oct 21)
- ✅ The four moves grid: `examples/four_moves.mp4` (Oct 21)
- A plaza sequence with **Render all shots** (`examples/sequence_plaza_4shots_a40.mp4`) is out of the cut for now: it
  still has the old glass-wall look
- ✅ A render of the scene blocked on camera (the 0:08 shot: plaza + a box and a person, Orbit right), so the
  render at 1:07 is of that scene: `examples/stage1_demo_scene_a40.mp4`, from `examples/demo_scene.json` and
  `examples/look_demo_scene_a40.png` (Oct 21). Its prompt names the person ("a woman in a red coat standing by
  stacked wooden crates"); without that, the stand-in renders as a post.
- Keep the real render waits out of the video: cut from "Render shot" to the result, and say how long it took (~3 min on an A40)
