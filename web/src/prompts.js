// Starter prompts for the Render panel. Describe the finished shot: what the grey shapes really are,
// the place, the light and the camera move; never "clay", "3D" or "Unreal" (see promptWarnings).

export const PROMPT_IDEAS = [
  {
    group: 'Plaza preset',
    prompts: [
      'A sunny stone plaza with a glass office tower, an iron lamp post, stacked wooden crates and a white market kiosk, slow push-in.',
      'Golden-hour light over a quiet Mediterranean square, warm stone walls, wooden crates beside a striped kiosk, slow dolly forward.',
      'A rainy night plaza lit by a single street lamp, wet cobblestones reflecting neon from a closed kiosk, crates stacked in the shadows, slow push-in.',
      'A snowy winter square at dusk with a brick clock tower, a glowing lamp post and a wooden market stall dusted with snow, gentle camera push.',
    ],
  },
  {
    group: 'Blocks preset / your own scene',
    prompts: [
      'Shipping containers on a foggy harbour quay at dawn, cranes in the distance, a dock worker standing by the crates, slow dolly in.',
      'Brutalist concrete buildings in a desert at noon, harsh shadows, a lone traveller walking between them, slow push-in.',
      'A neon-lit back alley in Tokyo at night, steam rising from vents, cardboard boxes stacked by a doorway, a figure in a raincoat.',
      'An abandoned warehouse with dusty sunbeams through broken windows, wooden pallets on the floor, a woman in a red coat.',
    ],
  },
];

/** n seeds for look variants, starting at `seed` (wrapping inside the 32-bit range ComfyUI accepts). */
export function variantSeeds(seed, n) {
  const s = Number.isInteger(seed) && seed >= 0 ? seed : 42;
  return Array.from({ length: n }, (_, i) => (s + i) % 2 ** 32);
}
