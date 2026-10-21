// Starter prompts for the Render panel. Describe the finished shot: what the grey shapes really are,
// the place, the light and the camera move; never "clay", "3D" or "Unreal" (see promptWarnings).
// Each one was checked on an A40 (Oct 21) against its preset's depth map with seeds 42, 2024 and 7: the
// look still has to keep the layout. Name the sky where the layout has sky and say where the big shapes
// are ("a tower on the left"), or the still fills the frame with something else (a glass wall, a stone
// wall, a shop front) and the render follows the still instead of the layout.

export const PROMPT_IDEAS = [
  {
    group: 'Plaza preset',
    prompts: [
      'A sunny stone plaza under a clear blue sky, a glass office tower on the left, an iron lamp post, stacked wooden crates and a white market kiosk, slow push-in.',
      'Golden-hour light over a quiet Mediterranean square under a pale evening sky, a tall stone bell tower on the left, an old lamp post, wooden crates beside a striped kiosk, slow dolly forward.',
      'A rainy night plaza, a dark office tower on the left, a single street lamp, crates stacked in the middle and a closed kiosk glowing with neon on the right, wet cobblestones, slow push-in.',
      'A snowy winter square at dusk with a tall brick building, a glowing lamp post, crates dusted with snow and a wooden market stall, gentle camera push.',
    ],
  },
  {
    group: 'Blocks preset / your own scene',
    prompts: [
      'Shipping containers on a foggy harbour quay at dawn, cranes in the distance, a dock worker standing by the crates, slow dolly in.',
      'Brutalist concrete buildings in a desert at noon, harsh shadows, a lone traveller walking between them, slow push-in.',
      'An empty Tokyo parking lot at night under a dark sky, two concrete blocks standing apart with glowing neon signs, cardboard boxes on the wet asphalt, a lone figure in a raincoat, slow push-in.',
      'An abandoned warehouse with dusty sunbeams through broken windows, wooden pallets on the floor, a woman in a red coat.',
    ],
  },
];

/** n seeds for look variants, starting at `seed` (wrapping inside the 32-bit range ComfyUI accepts). */
export function variantSeeds(seed, n) {
  const s = Number.isInteger(seed) && seed >= 0 ? seed : 42;
  return Array.from({ length: n }, (_, i) => (s + i) % 2 ** 32);
}
