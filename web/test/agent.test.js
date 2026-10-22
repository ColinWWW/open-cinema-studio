import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { describeStep, loadAgentSettings, normalizeAgentBase, saveAgentSettings } from '../src/agent/panel.js';
import { apiErrorMessage, runSceneAgent } from '../src/agent/runner.js';
import { TOOL_NAMES, TOOLS, ToolError, VIEW_SHOT, describeScene, runTool, toolDefinitions } from '../src/agent/tools.js';
import { blocksScene, normalizeScene } from '../src/presets.js';

const blank = () => runTool(normalizeScene(null), 'new_scene', { name: 'test' }).scene;
const linked = (s) => s.camera === s.shots[s.shot].camera;
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('every tool has a definition with an object schema, and a handler', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of [...TOOLS, VIEW_SHOT]) {
    assert.equal(t.input_schema.type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  assert.ok(!toolDefinitions().some((t) => t.name === 'view_shot'));
  assert.ok(toolDefinitions({ canView: true }).some((t) => t.name === 'view_shot'));
});

test('new_scene starts over, with the clip length and fog asked for', () => {
  const start = normalizeScene(blocksScene());
  const { scene, changed } = runTool(start, 'new_scene', { name: 'rainy street!', frames: 97, fog: [10, 60] });
  assert.ok(changed);
  assert.equal(scene.name, 'rainy_street_');
  assert.equal(scene.objects.length, 0);
  assert.equal(scene.output.frames, 97);
  assert.equal(Math.max(...scene.camera.keys.map((k) => k.frame)), 96);
  assert.deepEqual(scene.fog, [10, 60]);
  assert.equal(start.objects.length, 5, 'the scene passed in is left alone');
  assert.throws(() => runTool(start, 'new_scene', { name: 'x', frames: 70 }), ToolError);
});

test('add_objects places stand-ins in metres and degrees; walls have no depth', () => {
  const { scene, result } = runTool(blank(), 'add_objects', {
    objects: [
      { type: 'box', name: 'kiosk', position: [2, 0, 6], size: [3, 2.3, 1.5], turn: 90, grey: 0.7 },
      { type: 'person', name: 'woman', position: [-1, 0, 4] },
      { type: 'plane', name: 'shop front', position: [0, 0, 10], size: [8, 4, 3] },
    ],
  });
  assert.equal(result.ids.length, 3);
  const [kiosk, woman, wall] = scene.objects;
  assert.deepEqual(kiosk.scale, [3, 2.3, 1.5]);
  assert.ok(Math.abs(kiosk.rotation[1] - Math.PI / 2) < 1e-9);
  assert.equal(kiosk.grey, 0.7);
  assert.deepEqual(woman.scale, [1, 1, 1]);
  assert.deepEqual(wall.scale, [8, 4, 1]);
  assert.equal(describeScene(scene).objects[0].turn, 90);
});

test('bad input is a ToolError with a message the agent can act on', () => {
  const s = blank();
  const err = (name, input) => {
    try {
      runTool(s, name, input);
    } catch (e) {
      assert.ok(e instanceof ToolError, `${name}: ${e}`);
      return e.message;
    }
    assert.fail(`${name} accepted ${JSON.stringify(input)}`);
  };
  assert.match(err('add_objects', { objects: [{ type: 'car', name: 'x', position: [0, 0, 0] }] }), /type must be one of box, person, plane/);
  assert.match(err('add_objects', { objects: [{ type: 'box', name: 'x', position: [0, 0] }] }), /position must be \[x, y, z\]/);
  assert.match(err('add_objects', { objects: [{ type: 'box', name: 'x', position: [0, 0, 0], size: [1, 0, 1] }] }), /above 0/);
  assert.match(err('update_object', { id: 'nope' }), /no object with id/);
  assert.match(err('set_camera', { keys: [{ frame: 99, position: [0, 1.6, 0], target: [0, 1, 5] }] }), /from 0 to 64/);
  assert.match(err('set_camera', { keys: [{ frame: 0, position: [0, 1, 0], target: [0, 1, 0] }] }), /away from position/);
  assert.match(err('camera_move', { move: 'zoom' }), /move must be one of/);
  assert.match(err('remove_shot', { shot: 0 }), /at least one shot/);
  assert.match(err('fly', {}), /unknown tool/);
  assert.throws(() => runTool(s, 'get_scene', null), ToolError);
});

test('update_object moves a walking stand-in as a whole, keys and all', () => {
  let s = runTool(blank(), 'add_objects', { objects: [{ type: 'person', name: 'p', position: [0, 0, 0] }] }).scene;
  const id = s.objects[0].id;
  s = runTool(s, 'animate_object', { id, keys: [{ frame: 0, position: [0, 0, 0], turn: 0 }, { frame: 64, position: [0, 0, 4] }] }).scene;
  assert.equal(s.objects[0].keys.length, 2);
  s = runTool(s, 'update_object', { id, position: [1, 0, 0] }).scene;
  assert.deepEqual(s.objects[0].keys.map((k) => k.position), [[1, 0, 0], [1, 0, 4]]);
  s = runTool(s, 'animate_object', { id, keys: [{ frame: 0, position: [2, 0, 2], turn: 45 }] }).scene;
  assert.equal(s.objects[0].keys, undefined, 'one key: it stands still');
  assert.deepEqual(s.objects[0].position, [2, 0, 2]);
});

test('cameras: set_camera, camera_move and shots keep camera linked to the active shot', () => {
  let s = runTool(blank(), 'set_camera', { name: 'wide', fov: 60, lens_shift: 0.2, keys: [{ frame: 0, position: [0, 1.6, -6], target: [0, 1, 4] }] }).scene;
  assert.equal(s.shots[0].name, 'wide');
  assert.equal(s.camera.fov, 60);
  assert.equal(s.camera.keys.length, 1);
  s = runTool(s, 'camera_move', { move: 'dolly_in' }).scene;
  assert.equal(s.camera.keys.length, 2);
  assert.ok(s.camera.keys[1].position[2] > -6);
  const added = runTool(s, 'add_shot', { name: 'close' });
  s = added.scene;
  assert.equal(added.result.shot, 1);
  assert.equal(s.shot, 1);
  s = runTool(s, 'set_camera', { shot: 0, fov: 35 }).scene;
  assert.equal(s.shot, 0, 'editing a shot makes it the active one');
  assert.equal(s.shots[0].camera.fov, 35);
  assert.equal(s.shots[1].camera.fov, 60);
  assert.ok(linked(s));
  s = runTool(s, 'remove_shot', { shot: 1 }).scene;
  assert.equal(s.shots.length, 1);
  assert.ok(linked(s));
});

test('get_scene changes nothing; suggest_prompt returns the prompt', () => {
  const s = blank();
  const read = runTool(s, 'get_scene');
  assert.equal(read.changed, false);
  assert.equal(read.scene, s);
  const p = runTool(s, 'suggest_prompt', { prompt: '  A rainy street at night, slow push-in.  ' });
  assert.equal(p.prompt, 'A rainy street at night, slow push-in.');
  assert.equal(p.changed, false);
});

// A fake model that plays back a script of responses and records what it was sent.
function scripted(...responses) {
  const sent = [];
  const createMessage = async (params) => {
    sent.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error('script ran out');
    return typeof next === 'function' ? next(params) : next;
  };
  return { createMessage, sent };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('runSceneAgent runs the tool calls, returns errors to the model, and ends with its summary', async () => {
  const { createMessage, sent } = scripted(
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        toolUse('t1', 'new_scene', { name: 'street' }),
        toolUse('t2', 'add_objects', { objects: [{ type: 'car', name: 'cab', position: [0, 0, 5] }] }),
      ],
    },
    {
      stop_reason: 'tool_use',
      content: [
        toolUse('t3', 'add_objects', { objects: [{ type: 'box', name: 'cab', position: [0, 0, 5], size: [1.8, 1.5, 4.5] }] }),
        toolUse('t4', 'suggest_prompt', { prompt: 'A yellow cab on a rainy street.' }),
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Built a street with a cab.' }] },
  );
  const scenes = [];
  const steps = [];
  const out = await runSceneAgent({
    brief: 'a cab on a street',
    scene: normalizeScene(blocksScene()),
    createMessage,
    onScene: (s) => scenes.push(s),
    onStep: (s) => steps.push(s),
  });
  assert.equal(out.summary, 'Built a street with a cab.');
  assert.equal(out.prompt, 'A yellow cab on a rainy street.');
  assert.deepEqual(out.scene.objects.map((o) => o.name), ['cab']);
  assert.equal(scenes.length, 2, 'new_scene and the good add_objects changed the scene');
  assert.ok(steps[1].error.includes('type must be one of'));

  // The first request has the brief, the scene and the tools; no view_shot without a renderer.
  assert.match(sent[0].messages[0].content, /a cab on a street/);
  assert.match(sent[0].messages[0].content, /building left/);
  assert.ok(!sent[0].tools.some((t) => t.name === 'view_shot'));
  // The assistant turn goes back unchanged (thinking block included), then every result in one user message.
  assert.deepEqual(sent[1].messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig' });
  const results = sent[1].messages[2].content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2']);
  assert.equal(results[1].is_error, true);
  assert.equal(results[0].is_error, undefined);
});

test('runSceneAgent: view_shot sends the host image back; refusals and runaway loops stop with a message', async () => {
  const { createMessage, sent } = scripted(
    { stop_reason: 'tool_use', content: [toolUse('v1', 'view_shot', { frame: 64 })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  );
  const views = [];
  await runSceneAgent({
    brief: 'x',
    scene: blank(),
    createMessage,
    host: { viewShot: (_s, shot, frame) => (views.push([shot, frame]), { mediaType: 'image/jpeg', data: 'AAAA' }) },
  });
  assert.deepEqual(views, [[0, 64]]);
  assert.ok(sent[0].tools.some((t) => t.name === 'view_shot'));
  const image = sent[1].messages[2].content[0].content[1];
  assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });

  const refuse = scripted({ stop_reason: 'refusal', stop_details: { explanation: 'no' }, content: [] });
  await assert.rejects(runSceneAgent({ brief: 'x', scene: blank(), createMessage: refuse.createMessage }), /declined this brief: no/);

  const forever = scripted(...Array.from({ length: 3 }, (_, i) => ({ stop_reason: 'tool_use', content: [toolUse(`g${i}`, 'get_scene', {})] })));
  await assert.rejects(runSceneAgent({ brief: 'x', scene: blank(), createMessage: forever.createMessage, maxTurns: 3 }), /still working after 3 rounds/);

  await assert.rejects(runSceneAgent({ brief: '  ', scene: blank(), createMessage }), /Describe the scene/);
});

test('runSceneAgent stops when aborted', async () => {
  const controller = new AbortController();
  const { createMessage } = scripted(() => {
    controller.abort();
    return { stop_reason: 'tool_use', content: [toolUse('t1', 'get_scene', {})] };
  });
  await assert.rejects(runSceneAgent({ brief: 'x', scene: blank(), createMessage, signal: controller.signal }), { name: 'AbortError' });
});

test('API errors read well, from the SDK error classes', () => {
  const headers = new Headers();
  assert.equal(apiErrorMessage(Anthropic, new Anthropic.AuthenticationError(401, {}, 'bad key', headers)), 'The Claude API rejected the API key.');
  assert.match(apiErrorMessage(Anthropic, new Anthropic.RateLimitError(429, {}, 'slow down', headers)), /Rate limited/);
  assert.match(apiErrorMessage(Anthropic, new Anthropic.InternalServerError(500, {}, 'boom', headers)), /^Claude API error 500:/);
  assert.equal(apiErrorMessage(Anthropic, new Error('other')), null);
});

test('agent settings: the key stays in this browser; the "via" URL must be https', () => {
  const storage = memory();
  assert.deepEqual(loadAgentSettings(storage), { key: '', base: '' });
  saveAgentSettings({ key: 'sk-ant-x', base: 'https://relay.example.com' }, storage);
  assert.deepEqual(loadAgentSettings(storage), { key: 'sk-ant-x', base: 'https://relay.example.com' });
  saveAgentSettings({ key: '', base: '' }, storage);
  assert.equal(storage.m.size, 0);
  assert.equal(normalizeAgentBase(''), '');
  assert.equal(normalizeAgentBase('relay.example.com/v1/'), 'https://relay.example.com');
  assert.equal(normalizeAgentBase('http://localhost:8787'), 'http://localhost:8787');
  assert.throws(() => normalizeAgentBase('http://relay.example.com'), /https/);
  assert.throws(() => normalizeAgentBase('sk-ant-api03-abc'), /isn’t a web address/);
});

test('log lines', () => {
  assert.equal(describeStep({ name: 'add_objects', input: { objects: [{ name: 'kiosk' }, { type: 'person' }] } }), 'Added kiosk, person');
  assert.equal(describeStep({ name: 'camera_move', input: { move: 'dolly_in' } }), 'Camera move: dolly in');
  assert.match(describeStep({ name: 'update_object', input: {}, error: 'no object' }), /retrying: no object/);
});
