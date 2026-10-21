// Moving stand-ins: an object can carry keys {frame, position: [x,y,z], rotation: [x,y,z]} on the shot's
// timeline, shared by every shot (it's the blocking, not a camera). Between keys it moves at a steady speed
// (linear), so a person walks rather than eases. With no keys an object stays where its position says.
// obj.position / obj.rotation always hold the frame-0 pose, so anything that ignores keys sees the start.

import { sortKeys } from './cameraPath.js';

const lerp = (a, b, s) => a + (b - a) * s;
/** b's angle moved by whole turns to within half a turn of a, so 170° -> -170° turns 20°, not 340°. */
const near = (a, b) => b - 2 * Math.PI * Math.round((b - a) / (2 * Math.PI));
const pose = (p) => ({ position: [...p.position], rotation: [...p.rotation] });

export const isAnimated = (obj) => Array.isArray(obj.keys) && obj.keys.length > 1;

/** {position, rotation} of `obj` at a (possibly fractional) frame. */
export function objectPoseAt(obj, frame) {
  if (!isAnimated(obj)) return pose(obj);
  const k = sortKeys(obj.keys);
  if (frame <= k[0].frame) return pose(k[0]);
  const last = k[k.length - 1];
  if (frame >= last.frame) return pose(last);
  let i = 0;
  while (k[i + 1].frame <= frame) i++;
  const [a, b] = [k[i], k[i + 1]];
  const s = (frame - a.frame) / (b.frame - a.frame);
  return {
    position: a.position.map((v, j) => lerp(v, b.position[j], s)),
    rotation: a.rotation.map((v, j) => lerp(v, near(v, b.rotation[j]), s)),
  };
}

/** Keep obj.position / obj.rotation on the frame-0 pose after the keys change. */
function syncBase(obj) {
  if (!isAnimated(obj)) {
    if (obj.keys?.length === 1) Object.assign(obj, pose(obj.keys[0]));
    delete obj.keys;
    return obj;
  }
  return Object.assign(obj, objectPoseAt(obj, 0));
}

/**
 * Key `obj` at `frame` with pose {position, rotation}. The first key off frame 0 also keys frame 0 at the
 * object's current place, so it starts where it stood and moves to the new pose. Changes obj in place.
 */
export function keyObject(obj, frame, p) {
  const keys = isAnimated(obj) ? obj.keys.filter((k) => k.frame !== frame) : frame === 0 ? [] : [{ frame: 0, ...pose(obj) }];
  obj.keys = sortKeys([...keys, { frame, ...pose(p) }]);
  return syncBase(obj);
}

/** Remove the key at `frame`. One key left means no motion: the object stays at that pose. */
export function unkeyObject(obj, frame) {
  if (!isAnimated(obj)) return obj;
  obj.keys = obj.keys.filter((k) => k.frame !== frame);
  return syncBase(obj);
}

/**
 * The editor moved `obj` (gizmo or inspector) while showing `frame`: a moving object gets keyed there
 * (auto-key), a still one just moves.
 */
export function editObjectPose(obj, frame, p) {
  if (isAnimated(obj)) return keyObject(obj, frame, p);
  return Object.assign(obj, pose(p));
}

/** Shift a whole object, keys and all (Duplicate places the copy 1 m to the side). */
export function offsetObject(obj, d) {
  const add = (v) => v.map((x, i) => x + d[i]);
  obj.position = add(obj.position);
  if (obj.keys) obj.keys = obj.keys.map((k) => ({ ...k, position: add(k.position) }));
  return obj;
}

/** Positions along the path, one per frame, for drawing it; [] when the object doesn't move. */
export function objectPath(obj, frames) {
  if (!isAnimated(obj)) return [];
  return Array.from({ length: frames }, (_, i) => objectPoseAt(obj, i).position);
}

/** Valid keys from loaded JSON (or undefined): whole frames >= 0, three numbers each, one key per frame. */
export function normalizeObjectKeys(keys) {
  if (!Array.isArray(keys)) return undefined;
  const ok = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    if (!k || !Number.isInteger(k.frame) || k.frame < 0 || seen.has(k.frame) || !ok(k.position)) continue;
    seen.add(k.frame);
    out.push({ frame: k.frame, position: [...k.position], rotation: ok(k.rotation) ? [...k.rotation] : [0, 0, 0] });
  }
  return out.length > 1 ? sortKeys(out) : undefined;
}
