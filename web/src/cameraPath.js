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

// ---------- one-click camera moves ----------

export const MOVES = {
  dolly_in: 'Dolly in',
  dolly_out: 'Dolly out',
  truck_right: 'Truck right',
  truck_left: 'Truck left',
  crane_up: 'Crane up',
  crane_down: 'Crane down',
  orbit_right: 'Orbit right',
  orbit_left: 'Orbit left',
  static: 'Locked off',
};

const SUBJECT = 8; // metres: the moves are sized for a subject this far away (or nearer, if the target is)
const add3 = (a, b) => a.map((v, i) => v + b[i]);
const scale3 = (a, s) => a.map((v) => v * s);
const round3 = (a) => a.map((v) => Math.round(v * 1000) / 1000);

/**
 * Camera keys for a named move that starts from `start` ({position, target}, usually the frame-0 pose)
 * and lasts `frames` frames. Sizes follow scripts/make_test_layout.py's moves (dolly ~2-3 m, crane ~3 m,
 * orbit 60°). Returns {keys, ease}: the orbit is keyed every 8 frames along an eased arc, so it uses
 * linear easing between those keys; the other moves are two keys with smooth easing.
 */
export function cameraMove(move, start, frames) {
  if (!(move in MOVES)) throw new Error(`unknown camera move ${move}`);
  const p = start.position;
  const t = start.target;
  const view = t.map((v, i) => v - p[i]);
  const dist = Math.hypot(...view) || 1;
  const r = Math.min(dist, SUBJECT);
  const fwd = scale3(view, 1 / dist);
  const flat = Math.hypot(fwd[0], fwd[2]) || 1;
  const ahead = [fwd[0] / flat, 0, fwd[2] / flat]; // level forward
  const right = [-ahead[2], 0, ahead[0]]; // forward x up
  const last = frames - 1;
  const two = (dp, keepTarget = false) => ({
    ease: 'smooth',
    keys: [
      { frame: 0, position: round3(p), target: round3(t) },
      { frame: last, position: round3(add3(p, dp)), target: round3(keepTarget ? t : add3(t, dp)) },
    ],
  });

  switch (move) {
    case 'dolly_in':
      return two(scale3(ahead, 0.3 * r));
    case 'dolly_out':
      return two(scale3(ahead, -0.3 * r));
    case 'truck_right':
      return two(scale3(right, 0.6 * r));
    case 'truck_left':
      return two(scale3(right, -0.6 * r));
    case 'crane_up':
      return two([0, 0.4 * r, 0], true);
    case 'crane_down':
      return two([0, -Math.min(0.4 * r, p[1] - 0.3), 0], true);
    case 'static':
      return { ease: 'smooth', keys: [{ frame: 0, position: round3(p), target: round3(t) }] };
    default: {
      // orbit 60° around the subject: the target, or a point SUBJECT metres along the view
      const pivot = add3(p, scale3(fwd, r));
      const rel = p.map((v, i) => v - pivot[i]);
      const sign = move === 'orbit_right' ? 1 : -1; // + turns the camera towards its right
      const at = [];
      for (let f = 0; f < last; f += 8) at.push(f);
      at.push(last);
      const keys = at.map((f) => {
        const a = sign * (Math.PI / 3) * smoothstep(f / last);
        const [c, s] = [Math.cos(a), Math.sin(a)];
        const pos = [pivot[0] + rel[0] * c + rel[2] * s, p[1], pivot[2] - rel[0] * s + rel[2] * c];
        return { frame: f, position: round3(pos), target: round3(pivot) };
      });
      return { ease: 'linear', keys };
    }
  }
}
