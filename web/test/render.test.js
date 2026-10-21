import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aspectWarning, describeState, lookForm, promptWarnings, renderForm, runJob, runRender } from '../src/render.js';

test('promptWarnings flags empty prompts and layout words', () => {
  assert.deepEqual(promptWarnings('A sunny plaza with crates, slow push-in.'), []);
  assert.equal(promptWarnings('  ').length, 1);
  assert.equal(promptWarnings('Clay boxes in 3D, Unreal style').length, 3);
  assert.deepEqual(promptWarnings('A 3Dog bakery'), []); // whole words only
});

test('aspectWarning only fires when the look still will be cropped', () => {
  const output = { width: 960, height: 576 };
  assert.equal(aspectWarning(null, output), null);
  assert.equal(aspectWarning({ width: 1920, height: 1152 }, output), null);
  assert.match(aspectWarning({ width: 1024, height: 1024 }, output), /centre-cropped/);
});

test('renderForm carries the files and the clip spec', async () => {
  const form = renderForm({
    mp4: new Blob(['mp4'], { type: 'video/mp4' }), look: new Blob(['png']), lookName: 'look.jpg',
    prompt: 'a plaza', output: { width: 960, height: 576, frames: 65 }, seed: 7,
  });
  assert.equal(form.get('layout').name, 'layout.mp4');
  assert.equal(form.get('look').name, 'look.jpg');
  assert.deepEqual(['prompt', 'width', 'height', 'frames', 'seed'].map((k) => form.get(k)), ['a plaza', '960', '576', '65', '7']);
});

const reply = (body, status = 200) => ({ ok: status < 400, status, statusText: '', json: async () => body });

test('runRender polls until the render succeeds', async () => {
  const states = [
    { id: 'r1', status: 'running', stage: 'rendering', progress: 0.5 },
    { id: 'r1', status: 'succeeded', video_url: '/api/render/r1/video', seconds: 3 },
  ];
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts?.method || 'GET']);
    return url === '/api/render' ? reply({ id: 'r1', status: 'queued' }, 202) : reply(states.shift());
  };
  const seen = [];
  const final = await runRender(new FormData(), { fetchFn, sleep: async () => {}, onUpdate: (s) => seen.push(s.status) });
  assert.equal(final.video_url, '/api/render/r1/video');
  assert.deepEqual(seen, ['queued', 'running', 'succeeded']);
  assert.deepEqual(calls, [['/api/render', 'POST'], ['/api/render/r1', 'GET'], ['/api/render/r1', 'GET']]);
});

test('runRender surfaces server and node errors', async () => {
  await assert.rejects(runRender(new FormData(), { fetchFn: async () => reply({ error: 'frames must be 8k+1' }, 400) }), /8k\+1/);
  const fetchFn = async (url) => (url === '/api/render' ? reply({ id: 'r2', status: 'queued' }) : reply({ id: 'r2', status: 'failed', error: 'OOM (node 44)' }));
  await assert.rejects(runRender(new FormData(), { fetchFn, sleep: async () => {} }), /OOM/);
});

test('describeState reads well', () => {
  assert.equal(describeState({ status: 'succeeded', seconds: 161 }), 'Done in 161s');
  assert.match(describeState({ status: 'running', stage: 'rendering', progress: 0.25 }), /^Rendering 25%/);
  assert.equal(describeState({ status: 'failed', error: 'boom' }), 'Failed: boom');
});

test('lookForm carries the depth map and the clip size', () => {
  const form = lookForm({ depth: new Blob(['png']), prompt: 'a plaza', output: { width: 960, height: 576, frames: 65 }, seed: 3 });
  assert.equal(form.get('depth').name, 'depth.png');
  assert.deepEqual(['prompt', 'width', 'height', 'seed'].map((k) => form.get(k)), ['a plaza', '960', '576', '3']);
  assert.equal(form.get('strength'), null);
  assert.equal(lookForm({ depth: new Blob(['png']), prompt: 'p', output: { width: 960, height: 576 }, strength: 0.8 }).get('strength'), '0.8');
});

test('runJob polls the look endpoints', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts?.method || 'GET']);
    return url === '/api/look' ? reply({ id: 'l1', status: 'queued' }, 202) : reply({ id: 'l1', status: 'succeeded', image_url: '/api/look/l1/image' });
  };
  const final = await runJob('look', new FormData(), { fetchFn, sleep: async () => {} });
  assert.equal(final.image_url, '/api/look/l1/image');
  assert.deepEqual(calls, [['/api/look', 'POST'], ['/api/look/l1', 'GET']]);
  const failing = async (url) => (url === '/api/look' ? reply({ id: 'l2', status: 'queued' }) : reply({ id: 'l2', status: 'failed' }));
  await assert.rejects(runJob('look', new FormData(), { fetchFn: failing, sleep: async () => {} }), /look failed/);
});
