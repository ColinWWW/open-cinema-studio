// Starter scenes. "blocks" and "plaza" reproduce scripts/make_test_layout.py, which uses
// x-right-when-looking-down-+z; three.js is the mirror of that, so x is negated here.

const DEFAULT_OUTPUT = { width: 960, height: 576, frames: 65, fps: 24 };

let nextId = 1;
export const newId = () => `o${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Object from make_test_layout.py's (min corner, max corner, grey). Boxes sit on their base. */
function fromPy(name, lo, hi, grey) {
  return {
    id: newId(),
    name,
    type: 'box',
    position: [0 - (lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], // 0 - x, not -x: no -0 in saved JSON
    rotation: [0, 0, 0],
    scale: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
    grey,
  };
}

export function emptyScene() {
  return {
    version: 1,
    name: 'shot',
    objects: [],
    camera: {
      fov: 45,
      lensShift: 0,
      ease: 'smooth',
      keys: [
        { frame: 0, position: [0, 1.6, -8], target: [0, 1, 0] },
        { frame: 64, position: [0, 1.5, -5], target: [0, 1, 0] },
      ],
    },
    fog: [8, 38],
    output: { ...DEFAULT_OUTPUT },
  };
}

export function blocksScene() {
  return {
    version: 1,
    name: 'blocks_dolly_in',
    objects: [
      fromPy('building left', [-3.2, 0.0, 2.0], [-1.4, 3.4, 4.2], 0.78),
      fromPy('building right', [1.6, 0.0, 3.0], [3.6, 2.2, 5.6], 0.72),
      fromPy('crate', [-0.6, 0.0, 0.4], [0.2, 0.8, 1.2], 0.86),
      fromPy('small crate', [0.35, 0.0, 0.9], [0.85, 0.5, 1.4], 0.82),
      fromPy('person stand-in', [-0.95, 0.0, -0.35], [-0.55, 1.75, 0.05], 0.92),
    ],
    camera: {
      fov: 45,
      lensShift: 0,
      ease: 'smooth',
      keys: [
        { frame: 0, position: [0, 1.6, -7.5], target: [0, 0.9, 1] },
        { frame: 64, position: [0, 1.4, -4.5], target: [0, 0.9, 1] },
      ],
    },
    fog: [8, 38],
    output: { ...DEFAULT_OUTPUT },
  };
}

export function plazaScene() {
  return {
    version: 1,
    name: 'plaza_dolly_in',
    objects: [
      fromPy('glass tower', [-24.1, 0.0, 40.0], [-10.4, 34.0, 94.0], 0.74),
      fromPy('lamp post', [-4.69, 0.0, 7.52], [-4.54, 3.8, 7.67], 0.9),
      fromPy('lamp head', [-4.86, 3.8, 7.35], [-4.37, 4.74, 7.84], 0.88),
      fromPy('lamp base', [-4.8, 0.0, 7.4], [-4.43, 0.3, 7.79], 0.8),
      fromPy('big crate', [-1.29, 0.0, 6.0], [0.39, 1.43, 7.5], 0.86),
      fromPy('small crate', [0.3, 0.0, 6.5], [1.32, 1.03, 7.7], 0.82),
      fromPy('kiosk body', [1.75, 0.0, 7.6], [4.78, 2.3, 9.1], 0.84),
      fromPy('kiosk roof overhang', [1.2, 2.3, 7.45], [5.3, 2.6, 9.4], 0.92),
      fromPy('kiosk roof box', [1.85, 2.6, 7.7], [4.7, 3.13, 9.0], 0.88),
      fromPy('parapet wall', [-20.0, 0.0, 11.6], [20.0, 0.45, 12.0], 0.7),
    ],
    camera: {
      fov: 50,
      lensShift: 0.458,
      ease: 'smooth',
      keys: [
        { frame: 0, position: [0, 1.6, 0], target: [0, 1.6, 100] },
        { frame: 64, position: [0, 1.6, 2], target: [0, 1.6, 102] },
      ],
    },
    fog: [60, 180],
    output: { ...DEFAULT_OUTPUT },
  };
}

const vec3 = (v, fallback) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(Number) : fallback);

function normalizeCamera(cam, fallback) {
  const c = cam && typeof cam === 'object' ? cam : {};
  const keys = (Array.isArray(c.keys) ? c.keys : [])
    .filter((k) => k && Number.isInteger(k.frame) && vec3(k.position) && vec3(k.target))
    .map((k) => ({ frame: k.frame, position: k.position.map(Number), target: k.target.map(Number) }));
  return {
    fov: Number.isFinite(c.fov) ? c.fov : fallback.fov,
    lensShift: Number.isFinite(c.lensShift) ? c.lensShift : 0,
    ease: c.ease === 'linear' ? 'linear' : 'smooth',
    keys: keys.length ? keys : structuredClone(fallback.keys),
  };
}

/**
 * A scene holds several shots (cameras) over the same blocking. `camera` is the active shot's camera,
 * the very same object as shots[shot].camera, so the editor and exporter only ever look at `camera`.
 * Scenes saved before shots existed become one shot.
 */
function normalizeShots(data, fallback) {
  const list = Array.isArray(data.shots) && data.shots.length ? data.shots : [{ camera: data.camera }];
  const shots = list.map((s, i) => ({
    id: typeof s?.id === 'string' && s.id ? s.id : newId(),
    name: typeof s?.name === 'string' && s.name.trim() ? s.name : `Shot ${i + 1}`,
    camera: normalizeCamera(s?.camera, fallback),
  }));
  const shot = Number.isInteger(data.shot) && data.shot >= 0 && data.shot < shots.length ? data.shot : 0;
  return { shots, shot, camera: shots[shot].camera };
}

/** Fill in defaults and drop anything malformed, so a loaded or hand-edited JSON can't break the editor. */
export function normalizeScene(data) {
  const base = emptyScene();
  if (!data || typeof data !== 'object') data = {};
  const types = ['box', 'person', 'plane'];
  const objects = (Array.isArray(data.objects) ? data.objects : [])
    .filter((o) => o && types.includes(o.type))
    .map((o, i) => ({
      id: typeof o.id === 'string' && o.id ? o.id : newId(),
      name: typeof o.name === 'string' ? o.name : `${o.type} ${i + 1}`,
      type: o.type,
      position: vec3(o.position, [0, 0, 0]),
      rotation: vec3(o.rotation, [0, 0, 0]),
      scale: vec3(o.scale, [1, 1, 1]),
      grey: Number.isFinite(o.grey) ? Math.min(1, Math.max(0, o.grey)) : 0.8,
    }));
  const out = data.output || {};
  return {
    version: 1,
    name: typeof data.name === 'string' && data.name ? data.name : base.name,
    objects,
    ...normalizeShots(data, base.camera),
    fog: Array.isArray(data.fog) && data.fog.length === 2 && data.fog.every(Number.isFinite) ? data.fog : base.fog,
    output: {
      width: Number.isInteger(out.width) ? out.width : base.output.width,
      height: Number.isInteger(out.height) ? out.height : base.output.height,
      frames: Number.isInteger(out.frames) ? out.frames : base.output.frames,
      fps: base.output.fps,
    },
  };
}

export const PRESETS = {
  empty: { label: 'Empty', make: emptyScene },
  blocks: { label: 'Blocks (dolly in)', make: blocksScene },
  plaza: { label: 'Plaza (dolly in)', make: plazaScene },
};
