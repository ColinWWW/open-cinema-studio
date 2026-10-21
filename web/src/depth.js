// Depth map of the shot for the look-still ControlNet (Z-Image Fun ControlNet Union, depth mode).
// It expects relative inverse depth like Depth Anything's: near = white, far / sky = black.

/**
 * Turn view-space depths (one float per pixel, 0 = nothing hit, WebGL row order: bottom row first)
 * into RGBA greys, top row first. Grey = nearZ / z, so the nearest surface is white and the horizon
 * fades to black. nearZ is a low percentile of the visible depths, so one stray pixel can't wash it out.
 */
export function depthToGray(depth, width, height, { percentile = 0.005 } = {}) {
  const valid = depth.filter((z) => z > 0).sort();
  const out = new Uint8ClampedArray(width * height * 4);
  const nearZ = valid.length ? valid[Math.min(valid.length - 1, Math.floor(valid.length * percentile))] : 1;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const z = depth[src + x];
      const v = z > 0 ? Math.round(255 * Math.min(1, nearZ / z)) : 0;
      const o = (y * width + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return out;
}
