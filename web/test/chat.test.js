import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CALLS, chatPrompt, parseChatReply, replayChatCalls } from '../src/agent/chat.js';
import { describeStep, loadMode, saveMode } from '../src/agent/panel.js';
import { detectProvider } from '../src/agent/providers/index.js';
import { runTool } from '../src/agent/tools.js';
import { normalizeScene } from '../src/presets.js';

const blank = () => runTool(normalizeScene(null), 'new_scene', { name: 'test' }).scene;
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

const PLAN = {
  calls: [
    { tool: 'new_scene', input: { name: 'quay', frames: 65 } },
    { tool: 'add_objects', input: { objects: [{ type: 'box', name: 'container', position: [0, 0, 6], size: [6, 2.6, 2.4] }, { type: 'person', name: 'worker', position: [2, 0, 4] }] } },
    { tool: 'animate_object', input: { id: 'worker', keys: [{ frame: 0, position: [2, 0, 4] }, { frame: 64, position: [-1.5, 0, 4] }] } },
    { tool: 'update_object', input: { id: 'Container', grey: 0.5 } },
    { tool: 'set_camera', input: { name: 'wide', fov: 50, keys: [{ frame: 0, position: [0, 1.6, -4], target: [0, 1.2, 5] }] } },
    { tool: 'camera_move', input: { move: 'dolly_in' } },
    { tool: 'suggest_prompt', input: { prompt: 'A dock worker walks past a rusty shipping container at dawn, slow dolly in.' } },
  ],
  summary: 'A quay with a container and a worker.',
};

test('chat prompt: the agent instructions, every tool but get_scene, the JSON format, the brief and the scene', () => {
  const p = chatPrompt('  a dock worker by a container  ', blank());
  assert.match(p, /You block out shots for Open Cinema Studio/);
  assert.match(p, /"calls": \[\{"tool"/);
  for (const name of ['new_scene', 'add_objects', 'animate_object', 'set_camera', 'camera_move', 'suggest_prompt']) assert.match(p, new RegExp(`- ${name}: `));
  assert.doesNotMatch(p, /- get_scene: /);
  assert.doesNotMatch(p, /- view_shot: /);
  assert.match(p, /Brief:\na dock worker by a container\n/);
  assert.match(p, /"name":"test"/);
  assert.throws(() => chatPrompt('  ', blank()), /Describe the shot first/);
});

test('chat reply: JSON in a code block, bare, or as a list; chatter around it is ignored', () => {
  const json = JSON.stringify(PLAN);
  for (const reply of [`Here you go!\n\`\`\`json\n${json}\n\`\`\`\nEnjoy.`, json, `Sure: ${json} — tell me if you want changes`]) {
    const plan = parseChatReply(reply);
    assert.equal(plan.calls.length, 7);
    assert.deepEqual(plan.calls[0], { name: 'new_scene', input: { name: 'quay', frames: 65 } });
    assert.equal(plan.summary, PLAN.summary);
  }
  const list = parseChatReply(JSON.stringify([{ name: 'new_scene', input: { name: 'x' } }]));
  assert.deepEqual(list, { calls: [{ name: 'new_scene', input: { name: 'x' } }], summary: '' });
  // A code block that isn't JSON (say, an explanation in ```text) doesn't hide the JSON after it.
  assert.equal(parseChatReply(`\`\`\`text\nplan\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``).calls.length, 7);
});

test('chat reply: what the visitor sees when the paste is wrong', () => {
  assert.throws(() => parseChatReply('I can’t help with that.'), /no JSON in that reply/);
  assert.throws(() => parseChatReply('```json\n{"calls": [{"tool": "new_scene"\n```'), /doesn’t parse/);
  assert.throws(() => parseChatReply('{"scene": {}}'), /no "calls" list/);
  assert.throws(() => parseChatReply('{"calls": []}'), /no "calls" list/);
  assert.throws(() => parseChatReply('{"calls": [{"input": {}}]}'), /Step 1 .* no "tool"/);
  const many = JSON.stringify({ calls: Array.from({ length: MAX_CALLS + 1 }, () => ({ tool: 'get_scene' })) });
  assert.throws(() => parseChatReply(many), /at most 200/);
  assert.throws(() => parseChatReply(null), /no JSON/);
});

test('replay: builds the scene through the tools, names stand in for ids, and the prompt comes back', async () => {
  const scenes = [];
  const steps = [];
  const out = await replayChatCalls({ scene: blank(), calls: parseChatReply(JSON.stringify(PLAN)).calls, onScene: (s) => scenes.push(s), onStep: (s) => steps.push(s) });
  assert.equal(out.errors, 0);
  assert.equal(out.prompt, PLAN.calls[6].input.prompt);
  assert.equal(out.scene.name, 'quay');
  const [container, worker] = out.scene.objects;
  assert.equal(container.grey, 0.5); // "Container" found the object named container
  assert.equal(worker.keys.length, 2); // "worker" found the person
  assert.equal(out.scene.shots[0].camera.keys.length, 2); // dolly_in replaced the one key
  assert.equal(steps.length, 7);
  assert.ok(scenes.length >= 5);
});

test('replay: a call the tools refuse is skipped and reported; the rest still build', async () => {
  const steps = [];
  const calls = [
    { name: 'new_scene', input: { name: 'x' } },
    { name: 'add_objects', input: { objects: [{ type: 'tree', name: 'oak', position: [0, 0, 0] }] } },
    { name: 'update_object', input: { id: 'nobody', grey: 0.4 } },
    { name: 'view_shot', input: {} },
    { name: 'remove_objects', input: 'all' },
    { name: 'add_objects', input: { objects: [{ type: 'box', name: 'kiosk', position: [0, 0, 3] }] } },
    { name: 'remove_objects', input: { ids: ['kiosk'] } },
  ];
  const out = await replayChatCalls({ scene: blank(), calls, onStep: (s) => steps.push(s) });
  assert.equal(out.errors, 4);
  assert.equal(out.scene.objects.length, 0); // the kiosk was added, then removed by name
  assert.equal(out.prompt, null);
  const skipped = steps.filter((s) => s.skipped);
  assert.equal(skipped.length, 4);
  assert.match(describeStep(skipped[0]), /^Added oak — skipped: /);
  assert.match(describeStep({ name: 'set_camera', input: {}, error: 'bad keys' }), /retrying: bad keys/);
});

test('key shapes pick the provider; anything else is left to the picker', () => {
  assert.equal(detectProvider(' sk-ant-api03-abc '), 'claude');
  assert.equal(detectProvider('AIzaSyD-abc'), 'gemini');
  assert.equal(detectProvider('sk-proj-abc'), 'openai');
  assert.equal(detectProvider('sk-abc'), 'openai');
  assert.equal(detectProvider('relay-token'), '');
  assert.equal(detectProvider(''), '');
  assert.equal(detectProvider(undefined), '');
});

test('mode: chat-app when there is no key, the API key when one is saved, and the last pick wins', () => {
  const s = memory();
  assert.equal(loadMode({}, s), 'chat');
  assert.equal(loadMode({ hasKey: true }, s), 'key');
  saveMode('chat', s);
  assert.equal(loadMode({ hasKey: true }, s), 'chat');
  s.setItem('ocs.agentMode', 'nonsense');
  assert.equal(loadMode({}, s), 'chat');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadMode({ hasKey: true }, blocked), 'key');
  assert.doesNotThrow(() => saveMode('key', blocked));
});
