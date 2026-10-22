// Scene tools: the one contract every agent uses to block out a scene before anyone writes a render prompt.
// Each tool is a JSON Schema (the Claude API's tool format, which MCP and most agent frameworks also take)
// plus a pure function scene -> scene, so the same tools run in the editor's agent panel (agent/panel.js),
// from page scripts and browser agents (window.ocs.agent), and headless in node (scripts/design-scene.mjs).
// Tools never trust their input: anything malformed throws a ToolError, which the caller hands back to the
// agent as an error result so it can fix the call. See docs/AGENTS.md.

import { MOVES, cameraMove, poseAt } from '../cameraPath.js';
import { normalizeObjectKeys } from '../objectPath.js';
import { emptyScene, newId, normalizeScene } from '../presets.js';
import { addShot, removeShot, rescaleShots, selectShot } from '../shots.js';
import { FRAME_COUNTS } from '../spec.js';

export class ToolError extends Error {}

const TYPES = ['box', 'person', 'plane'];
const DEG = Math.PI / 180;
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);

// ---------- input checks ----------

function fail(msg) {
  throw new ToolError(msg);
}
function vec3(v, what) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    fail(`${what} must be [x, y, z], three numbers in metres`);
  }
  return [...v];
}
function num(v, what, lo = -Infinity, hi = Infinity) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail(`${what} must be a number from ${lo} to ${hi}`);
  return v;
}
function text(v, what, max = 80) {
  if (typeof v !== 'string' || !v.trim()) fail(`${what} must be a non-empty string`);
  return v.trim().slice(0, max);
}
function frameOf(scene, v, what = 'frame') {
  const last = scene.output.frames - 1;
  if (!Number.isInteger(v) || v < 0 || v > last) fail(`${what} must be a whole frame from 0 to ${last}`);
  return v;
}
function objectById(scene, id) {
  const obj = scene.objects.find((o) => o.id === id);
  if (!obj) fail(`no object with id ${JSON.stringify(id)}; get_scene lists the ids`);
  return obj;
}
function shotIndex(scene, v) {
  if (v === undefined) return scene.shot;
  if (!Number.isInteger(v) || v < 0 || v >= scene.shots.length) fail(`shot must be 0 to ${scene.shots.length - 1}`);
  return v;
}
function size(type, v) {
  const s = vec3(v, 'size');
  if (!s.every((x) => x > 0)) fail('size values must be above 0');
  if (type === 'plane') s[2] = 1; // a wall has no depth
  return s;
}
function cameraKeys(scene, keys) {
  if (!Array.isArray(keys) || !keys.length) fail('keys must be a list of {frame, position, target}');
  const seen = new Set();
  return keys
    .map((k, i) => {
      const frame = frameOf(scene, k?.frame, `keys[${i}].frame`);
      if (seen.has(frame)) fail(`two camera keys on frame ${frame}`);
      seen.add(frame);
      const position = vec3(k.position, `keys[${i}].position`);
      const target = vec3(k.target, `keys[${i}].target`);
      if (Math.hypot(...position.map((x, j) => x - target[j])) < 0.01) fail(`keys[${i}]: target must be away from position`);
      return { frame, position, target };
    })
    .sort((a, b) => a.frame - b.frame);
}

// ---------- what the agent sees ----------

const objectView = (o) => ({
  id: o.id,
  name: o.name,
  type: o.type,
  position: r3(o.position),
  size: r3(o.scale),
  turn: Math.round((o.rotation[1] / DEG) * 10) / 10,
  grey: o.grey,
  ...(o.keys ? { keys: o.keys.map((k) => ({ frame: k.frame, position: r3(k.position), turn: Math.round((k.rotation[1] / DEG) * 10) / 10 })) } : {}),
});
const shotView = (s, i) => ({
  shot: i,
  name: s.name,
  fov: s.camera.fov,
  lens_shift: s.camera.lensShift,
  ease: s.camera.ease,
  keys: s.camera.keys.map((k) => ({ frame: k.frame, position: r3(k.position), target: r3(k.target) })),
});

/** A compact JSON view of the scene in the tools' own terms (size, turn in degrees, lens_shift). */
export function describeScene(scene) {
  return {
    name: scene.name,
    frames: scene.output.frames,
    fps: scene.output.fps,
    resolution: [scene.output.width, scene.output.height],
    fog: scene.fog,
    objects: scene.objects.map(objectView),
    active_shot: scene.shot,
    shots: scene.shots.map(shotView),
  };
}

// ---------- the tools ----------

const VEC3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const OBJECT_FIELDS = {
  name: { type: 'string', description: 'What the shape stands in for, e.g. "kiosk", "woman in red coat".' },
  position: { ...VEC3, description: 'Centre of the base, in metres. y is up; the floor is y = 0, so things standing on it have y = 0.' },
  size: { ...VEC3, description: 'Box: [width x, height y, depth z] in metres. Person: a scale, [1, 1, 1] is 1.75 m tall. Wall: [width, height, ignored].' },
  turn: { type: 'number', description: 'Turn about the vertical axis in degrees (counter-clockwise seen from above).' },
  grey: { type: 'number', description: 'Shade from 0.3 (dark) to 1 (white). Vary it so neighbouring shapes read apart.' },
};
const SHOT = { type: 'integer', description: 'Shot index (0-based). Defaults to the active shot.' };
const CAMERA_KEY = {
  type: 'object',
  properties: { frame: { type: 'integer' }, position: VEC3, target: { ...VEC3, description: 'The point the camera looks at.' } },
  required: ['frame', 'position', 'target'],
};

/**
 * Tool definitions (Claude API format: name, description, input_schema). `view_shot` is listed only when
 * the host can render (the browser), see toolDefinitions().
 */
export const TOOLS = [
  {
    name: 'get_scene',
    description: 'The whole scene as JSON: output settings, every object (with ids) and every shot camera.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'new_scene',
    description: 'Start over: no objects, one shot with a default camera. Use it when the brief is a new scene rather than a change to this one.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short file-safe name, e.g. "harbour_dawn".' },
        frames: { type: 'integer', enum: FRAME_COUNTS, description: 'Clip length at 24 fps: 65 (2.7 s), 97 (4 s) or 121 (5 s). Default 65.' },
        fog: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[near, far] metres. About [8, 38] for a street corner, [60, 180] for a big plaza with distant towers.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_objects',
    description: 'Add stand-ins: "box" for anything solid (buildings, crates, cars, furniture, trees as rough blocks), "person" for people, "plane" for a thin wall or sign. Returns their ids.',
    input_schema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          items: { type: 'object', properties: { type: { type: 'string', enum: TYPES }, ...OBJECT_FIELDS }, required: ['type', 'name', 'position'] },
        },
      },
      required: ['objects'],
    },
  },
  {
    name: 'update_object',
    description: 'Change an object: any of name, position, size, turn, grey. A moving object (one with keys) is shifted as a whole when you change its position.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, ...OBJECT_FIELDS }, required: ['id'] },
  },
  {
    name: 'remove_objects',
    description: 'Delete objects by id.',
    input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
  {
    name: 'animate_object',
    description: 'Make an object move: its poses at given frames, straight lines at a steady speed in between (a person walking about 1.4 m/s covers 3.8 m in 65 frames). The first key sets where it starts. Pass a single key, or none, to make it stand still at that pose.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'object', properties: { frame: { type: 'integer' }, position: VEC3, turn: { type: 'number' } }, required: ['frame', 'position'] },
        },
      },
      required: ['id', 'keys'],
    },
  },
  {
    name: 'set_camera',
    description: 'Set a shot camera: lens, and its keys (position and look-at target per frame; it eases between them). Two keys make a simple move; one key is a locked-off shot. Eye height is about 1.6 m.',
    input_schema: {
      type: 'object',
      properties: {
        shot: SHOT,
        name: { type: 'string', description: 'Shot name, e.g. "wide", "close on kiosk".' },
        fov: { type: 'number', description: 'Vertical field of view in degrees: 60-75 wide, 40-50 normal, 15-30 long lens.' },
        lens_shift: { type: 'number', description: 'Moves the horizon down (positive, up to 1) or up (negative) without tilting, for tall buildings. Default 0.' },
        ease: { type: 'string', enum: ['smooth', 'linear'] },
        keys: { type: 'array', items: CAMERA_KEY },
      },
    },
  },
  {
    name: 'camera_move',
    description: `Replace a shot's keys with a standard move sized for the subject, starting from its frame-0 framing (set that first with set_camera). Moves: ${Object.keys(MOVES).join(', ')}.`,
    input_schema: { type: 'object', properties: { shot: SHOT, move: { type: 'string', enum: Object.keys(MOVES) } }, required: ['move'] },
  },
  {
    name: 'add_shot',
    description: 'Add a shot after the active one (it starts as a copy of that camera) and make it active. Every shot films the same blocking; they are cut together in order.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'remove_shot',
    description: 'Delete a shot (never the last one).',
    input_schema: { type: 'object', properties: { shot: SHOT }, required: ['shot'] },
  },
  {
    name: 'suggest_prompt',
    description: 'Write the render prompt for the finished shot: one or two sentences saying what each grey shape really is, the place, the sky and light, and the camera move. Name where the big shapes are ("a tower on the left"). Never mention grey boxes, clay, 3D or a game engine.',
    input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  },
];

export const VIEW_SHOT = {
  name: 'view_shot',
  description: 'See what a shot camera films (the grey layout, as the render will follow it) at a frame. Use it to check the framing after you build or change the shot.',
  input_schema: { type: 'object', properties: { shot: SHOT, frame: { type: 'integer', description: 'Default 0.' } } },
};

/** The tools to offer an agent; view_shot only when the host can render it. */
export const toolDefinitions = ({ canView = false } = {}) => (canView ? [...TOOLS, VIEW_SHOT] : TOOLS);

const clone = (scene) => normalizeScene(structuredClone(scene));

function applyFields(obj, input) {
  if (input.name !== undefined) obj.name = text(input.name, 'name');
  if (input.size !== undefined) obj.scale = size(obj.type, input.size);
  if (input.grey !== undefined) obj.grey = num(input.grey, 'grey', 0.3, 1);
  const turn = input.turn !== undefined ? num(input.turn, 'turn', -3600, 3600) * DEG : undefined;
  if (input.position !== undefined || turn !== undefined) {
    const position = input.position !== undefined ? vec3(input.position, 'position') : obj.position;
    const d = position.map((v, i) => v - obj.position[i]);
    const dTurn = turn !== undefined ? turn - obj.rotation[1] : 0;
    obj.position = position;
    obj.rotation = [0, obj.rotation[1] + dTurn, 0];
    if (obj.keys) obj.keys = obj.keys.map((k) => ({ ...k, position: k.position.map((v, i) => v + d[i]), rotation: [0, k.rotation[1] + dTurn, 0] }));
  }
  return obj;
}

const HANDLERS = {
  get_scene: (scene) => ({ scene, result: describeScene(scene) }),

  new_scene(_scene, input) {
    const next = normalizeScene(emptyScene());
    next.name = text(input.name, 'name').replace(/[^\w.-]+/g, '_');
    if (input.frames !== undefined) {
      if (!FRAME_COUNTS.includes(input.frames)) fail(`frames must be one of ${FRAME_COUNTS.join(', ')}`);
      rescaleShots(next, next.output.frames, input.frames);
      next.output.frames = input.frames;
    }
    if (input.fog !== undefined) {
      if (!Array.isArray(input.fog) || input.fog.length !== 2) fail('fog must be [near, far]');
      const [near, far] = [num(input.fog[0], 'fog near', 0, 5000), num(input.fog[1], 'fog far', 1, 10000)];
      if (far <= near) fail('fog far must be beyond near');
      next.fog = [near, far];
    }
    const scene = normalizeScene(next);
    return { scene, result: { ok: true, frames: scene.output.frames, resolution: [scene.output.width, scene.output.height] } };
  },

  add_objects(scene, input) {
    if (!Array.isArray(input.objects) || !input.objects.length) fail('objects must be a non-empty list');
    if (scene.objects.length + input.objects.length > 200) fail('a scene holds at most 200 objects');
    const added = input.objects.map((o, i) => {
      if (!TYPES.includes(o?.type)) fail(`objects[${i}].type must be one of ${TYPES.join(', ')}`);
      const obj = { id: newId(), name: '', type: o.type, position: [0, 0, 0], rotation: [0, 0, 0], scale: o.type === 'plane' ? [4, 3, 1] : [1, 1, 1], grey: 0.8 };
      applyFields(obj, { ...o, position: vec3(o.position, `objects[${i}].position`), name: o.name ?? o.type });
      return obj;
    });
    scene.objects.push(...added);
    return { scene, result: { ids: added.map((o) => ({ id: o.id, name: o.name })) } };
  },

  update_object(scene, input) {
    applyFields(objectById(scene, input.id), input);
    return { scene, result: { ok: true } };
  },

  remove_objects(scene, input) {
    if (!Array.isArray(input.ids) || !input.ids.length) fail('ids must be a non-empty list');
    for (const id of input.ids) objectById(scene, id);
    scene.objects = scene.objects.filter((o) => !input.ids.includes(o.id));
    return { scene, result: { removed: input.ids.length } };
  },

  animate_object(scene, input) {
    const obj = objectById(scene, input.id);
    if (!Array.isArray(input.keys)) fail('keys must be a list of {frame, position, turn?}');
    const keys = input.keys.map((k, i) => ({
      frame: frameOf(scene, k?.frame, `keys[${i}].frame`),
      position: vec3(k.position, `keys[${i}].position`),
      rotation: [0, k.turn !== undefined ? num(k.turn, `keys[${i}].turn`, -3600, 3600) * DEG : obj.rotation[1], 0],
    }));
    if (new Set(keys.map((k) => k.frame)).size !== keys.length) fail('two keys on the same frame');
    delete obj.keys;
    const moving = normalizeObjectKeys(keys);
    if (moving) obj.keys = moving;
    else if (keys.length) Object.assign(obj, { position: keys[0].position, rotation: keys[0].rotation });
    return { scene, result: { moving: Boolean(moving) } };
  },

  set_camera(scene, input) {
    const i = shotIndex(scene, input.shot);
    selectShot(scene, i);
    const cam = scene.camera;
    if (input.name !== undefined) scene.shots[i].name = text(input.name, 'name');
    if (input.fov !== undefined) cam.fov = num(input.fov, 'fov', 10, 120);
    if (input.lens_shift !== undefined) cam.lensShift = num(input.lens_shift, 'lens_shift', -1, 1);
    if (input.ease !== undefined) {
      if (!['smooth', 'linear'].includes(input.ease)) fail('ease must be smooth or linear');
      cam.ease = input.ease;
    }
    if (input.keys !== undefined) cam.keys = cameraKeys(scene, input.keys);
    return { scene, result: shotView(scene.shots[i], i) };
  },

  camera_move(scene, input) {
    if (!(input.move in MOVES)) fail(`move must be one of ${Object.keys(MOVES).join(', ')}`);
    const i = shotIndex(scene, input.shot);
    selectShot(scene, i);
    const { keys, ease } = cameraMove(input.move, poseAt(scene.camera.keys, 0, scene.camera.ease), scene.output.frames);
    Object.assign(scene.camera, { keys, ease });
    return { scene, result: shotView(scene.shots[i], i) };
  },

  add_shot(scene, input) {
    addShot(scene);
    scene.shots[scene.shot].name = text(input.name, 'name');
    return { scene, result: { shot: scene.shot, name: scene.shots[scene.shot].name } };
  },

  remove_shot(scene, input) {
    if (scene.shots.length < 2) fail('a scene keeps at least one shot');
    removeShot(scene, shotIndex(scene, input.shot));
    return { scene, result: { shots: scene.shots.length, active_shot: scene.shot } };
  },

  suggest_prompt(scene, input) {
    return { scene, result: { ok: true }, prompt: text(input.prompt, 'prompt', 1000) };
  },
};

export const TOOL_NAMES = Object.keys(HANDLERS);

/**
 * Run one tool on `scene` (left untouched). Returns {scene, changed, result, prompt?}: the next scene (the same
 * object when nothing changed), a JSON-able result for the agent, and the render prompt when the tool was
 * suggest_prompt. Throws ToolError on bad input.
 */
export function runTool(scene, name, input = {}) {
  const handler = HANDLERS[name];
  if (!handler) throw new ToolError(`unknown tool ${JSON.stringify(name)}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolError('input must be an object');
  const out = handler(clone(scene), input);
  const next = normalizeScene(out.scene);
  const changed = JSON.stringify(next) !== JSON.stringify(normalizeScene(scene));
  return { ...out, scene: changed ? next : scene, changed };
}

