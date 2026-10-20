// Layout clip specs for LTX-2.5 Layout-to-Render (see docs/PLAN.md §3).
export const FPS = 24;
export const RESOLUTIONS = [
  [960, 576],
  [960, 512],
  [1920, 1088],
];
export const FRAME_COUNTS = [65, 97, 121]; // ~2.7 s, 4 s, 5 s

export function snapFrames(n) {
  return Math.max(1, Math.floor((n - 1) / 8) * 8 + 1);
}

/** Returns a list of problems; empty means the clip meets the spec. */
export function checkOutput({ width, height, frames, fps }) {
  const problems = [];
  if (width % 64 || height % 64) problems.push(`${width}x${height}: width and height must be divisible by 64`);
  if (snapFrames(frames) !== frames) problems.push(`${frames} frames: must be 8k+1 (65, 97, 121, ...)`);
  if (fps !== FPS) problems.push(`${fps} fps: must be ${FPS}`);
  return problems;
}
