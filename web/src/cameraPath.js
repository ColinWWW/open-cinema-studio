// Shot camera path: keys are {frame, position: [x,y,z], target: [x,y,z]}.
// Between keys the camera moves with smoothstep easing (same curve as scripts/make_test_layout.py).

export const smoothstep = (t) => t * t * (3 - 2 * t);

const lerp3 = (a, b, s) => a.map((v, i) => v + (b[i] - v) * s);
const copyPose = (k) => ({ position: [...k.position], target: [...k.target] });

export function sortKeys(keys) {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

/** Camera pose at a (possibly fractional) frame, or null when there are no keys. */
export function poseAt(keys, frame, ease = 'smooth') {
  if (!keys.length) return null;
  const k = sortKeys(keys);
  if (frame <= k[0].frame) return copyPose(k[0]);
  const last = k[k.length - 1];
  if (frame >= last.frame) return copyPose(last);
  let i = 0;
  while (k[i + 1].frame <= frame) i++;
  const a = k[i];
  const b = k[i + 1];
  const u = (frame - a.frame) / (b.frame - a.frame);
  const s = ease === 'linear' ? u : smoothstep(u);
  return { position: lerp3(a.position, b.position, s), target: lerp3(a.target, b.target, s) };
}

/** Insert or replace the key at key.frame; returns a new sorted array. */
export function setKey(keys, key) {
  return sortKeys([...keys.filter((k) => k.frame !== key.frame), key]);
}

export function removeKey(keys, frame) {
  return keys.filter((k) => k.frame !== frame);
}

/** Stretch keys from a clip of `from` frames to one of `to` frames, keeping the move over the whole clip. */
export function rescaleKeys(keys, from, to) {
  if (from <= 1 || to <= 1) return keys;
  const out = [];
  for (const k of sortKeys(keys)) {
    const frame = Math.round((k.frame * (to - 1)) / (from - 1));
    if (!out.some((o) => o.frame === frame)) out.push({ ...k, frame });
  }
  return out;
}
