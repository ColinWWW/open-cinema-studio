import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  COMFY_CLOUD, LOOK_NODES, NODES, abortableSleep, assetRef, buildLookStill, buildStage1, checkDims, cloudLook, cloudRender,
  comfyClient, loadCloud, lookSize, normalizeBase, panelState, redact, runCloudJob, saveCloud, stage1Size,
} from '../src/cloud.js';
import { describeState, loadTarget, saveTarget } from '../src/render.js';

const committed = (name) => JSON.parse(fs.readFileSync(new URL(`../../workflows/${name}`, import.meta.url), 'utf8'));
const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('sizes match server/workflow.py', () => {
  assert.deepEqual(stage1Size(960, 576), [960, 576]);
  assert.deepEqual(stage1Size(1920, 1088), [960, 544]);
  assert.deepEqual(lookSize(960, 576), [1328, 800]); // workflows/README.md
  assert.deepEqual(lookSize(1920, 1088), [1360, 768]);
  assert.throws(() => lookSize(1000, 576), /divisible by 64/);
  assert.throws(() => checkDims(960, 576, 64), /8k\+1/);
  assert.throws(() => checkDims(960, 570, 65), /divisible by 64/);
});

test('buildStage1 is the committed graph with the inputs server/render.py sets', () => {
  const file = committed('stage1_layout_api.json');
  const g = buildStage1({ layout: { id: 'a1', file_path: 'layout.mp4' }, look: { id: 'a2', hash: 'blake3:ff' }, prompt: 'a plaza', width: 1920, height: 1088, frames: 121, seed: 7 });
  assert.deepEqual(g[NODES.layout].inputs.file, { __type: 'core/ASSET', info: { id: 'a1', file_path: 'layout.mp4' } });
  assert.deepEqual(g[NODES.look].inputs.image, { __type: 'core/ASSET', info: { id: 'a2', hash: 'blake3:ff' } });
  assert.equal(g[NODES.prompt].inputs.text, 'a plaza');
  assert.deepEqual([g[NODES.latent].inputs.width, g[NODES.latent].inputs.height, g[NODES.latent].inputs.length], [960, 544, 121]);
  assert.equal(g[NODES.audio].inputs.frames_number, 121);
  assert.equal(g[NODES.seed].inputs.noise_seed, 7);
  // nothing else changes, and the committed file is untouched
  for (const id of Object.keys(file)) if (![NODES.layout, NODES.look, NODES.prompt, NODES.latent, NODES.audio, NODES.seed].includes(id)) assert.deepEqual(g[id], file[id]);
  assert.equal(committed('stage1_layout_api.json')[NODES.prompt].inputs.text, '');
  assert.throws(() => buildStage1({ layout: {}, look: {}, prompt: ' ', width: 960, height: 576, frames: 65 }), /prompt is empty/);
});

test('buildLookStill sets the depth, sizes, seed and strength like the server', () => {
  const file = committed('look_still_depth_api.json');
  const g = buildLookStill({ depth: { id: 'd1' }, prompt: 'a plaza', width: 960, height: 576, seed: 3, strength: 0.8 });
  assert.deepEqual(g[LOOK_NODES.depth].inputs.image, assetRef({ id: 'd1' }));
  assert.deepEqual([g['11'].inputs.width, g['11'].inputs.height], [1328, 800]);
  assert.deepEqual([g[LOOK_NODES.latent].inputs.width, g[LOOK_NODES.latent].inputs.height], [1328, 800]);
  assert.deepEqual([g['51'].inputs.width, g['51'].inputs.height], [960, 576]);
  assert.equal(g[LOOK_NODES.sampler].inputs.seed, 3);
  assert.equal(g['5'].inputs.strength, 0.8);
  // defaults reproduce the committed file apart from the asset and the prompt
  const d = buildLookStill({ depth: { id: 'd1' }, prompt: 'x', width: 960, height: 576 });
  d[LOOK_NODES.depth].inputs.image = file[LOOK_NODES.depth].inputs.image;
  d[LOOK_NODES.prompt].inputs.text = '';
  assert.deepEqual(d, file);
});

test('normalizeBase only sends the key over https (or to this machine)', () => {
  assert.equal(normalizeBase(''), COMFY_CLOUD);
  assert.equal(normalizeBase('ocs-comfy-relay.me.workers.dev/'), 'https://ocs-comfy-relay.me.workers.dev');
  assert.equal(normalizeBase('https://cloud.comfy.org/api/v2'), COMFY_CLOUD);
  assert.equal(normalizeBase('http://127.0.0.1:8189'), 'http://127.0.0.1:8189');
  assert.throws(() => normalizeBase('http://relay.example.com'), /https/);
  assert.throws(() => normalizeBase('https://u:p@relay.example.com'), /user:password/);
  // the key pasted into "via" by mistake would go out as a DNS lookup and show on screen
  assert.throws(() => normalizeBase('comfyui-0123456789abcdef'), /did the key go in/);
  assert.throws(() => normalizeBase('https://intranet'), /web address/);
  assert.equal(normalizeBase('http://localhost:8189/'), 'http://localhost:8189');
});

test('the key is only ever in localStorage under ocs.comfyKey, and Forget key removes it', () => {
  const local = memory();
  const session = memory();
  saveCloud({ key: 'comfyui-test', base: 'https://relay.example.dev' }, local);
  assert.deepEqual([...local.m.keys()].sort(), ['ocs.comfyBase', 'ocs.comfyKey']);
  assert.equal(session.m.size, 0);
  saveCloud({ key: '', base: 'https://relay.example.dev' }, local); // what Forget key saves
  assert.deepEqual([...local.m.keys()], ['ocs.comfyBase']);
  assert.equal(loadCloud(local).key, '');
  assert.ok(![...local.m.values()].some((v) => v.includes('comfyui-test')));
});

test('the key and the target stay in this browser storage', () => {
  const s = memory();
  assert.deepEqual(loadCloud(s), { key: '', base: COMFY_CLOUD });
  saveCloud({ key: 'comfyui-test', base: 'https://relay.example.dev' }, s);
  assert.deepEqual(loadCloud(s), { key: 'comfyui-test', base: 'https://relay.example.dev' });
  saveCloud({ key: '', base: COMFY_CLOUD }, s);
  assert.equal(s.m.size, 0);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  assert.deepEqual(loadCloud(blocked), { key: '', base: COMFY_CLOUD });
  saveCloud({ key: 'k', base: COMFY_CLOUD }, blocked); // no throw
  assert.equal(loadTarget(s), 'server');
  saveTarget('cloud', s);
  assert.equal(loadTarget(s), 'cloud');
  saveTarget('server', s);
  assert.equal(s.m.size, 0);
});

// ---------- the client against a mocked Comfy API v2 ----------

const reply = (body, status = 200) => new Response(body instanceof Blob ? body : JSON.stringify(body), {
  status, headers: { 'Content-Type': body instanceof Blob ? body.type : 'application/json' },
});

/** A fake Comfy API: records calls, runs each job through queued -> running -> `finish`. */
function fakeComfy({ finish = 'succeeded', error } = {}) {
  const calls = [];
  const jobs = new Map();
  let n = 0;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname + u.search, headers: init.headers, body: init.body });
    if (init.headers?.Authorization !== 'Bearer comfyui-test') return reply({ error: { code: 'unauthorized', message: 'invalid API key' } }, 401);
    const m = u.pathname.match(/^\/api\/v2\/(assets|jobs)(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (!m) return reply({ error: { code: 'not_found', message: 'nope' } }, 404);
    const [, what, id, sub] = m;
    if (what === 'jobs' && !id && method === 'GET') return reply({ jobs: [] });
    if (what === 'assets' && method === 'POST') {
      const f = init.body.get('file');
      return reply({ id: `asset-${++n}`, hash: null, file_path: init.body.get('file_path'), content_type: f.type, size_bytes: f.size }, 201);
    }
    if (what === 'assets' && sub === 'content') return reply(new Blob([`bytes of ${id}`], { type: 'video/mp4' }));
    if (what === 'jobs' && method === 'POST' && !id) {
      const { workflow } = JSON.parse(init.body);
      const output = workflow['60'];
      const job = { id: `job-${++n}`, status: 'queued', created_at: '2026-10-21T10:00:00Z', progress: null, outputs: [], error: null, workflow,
        steps: ['running', finish], type: output.inputs.images ? 'image' : 'video' };
      jobs.set(job.id, job);
      return reply(job, 201);
    }
    const job = jobs.get(id);
    if (sub === 'cancel') {
      job.steps = ['canceled'];
      return reply({ ...job, status: 'canceling' });
    }
    job.status = job.steps.shift() ?? job.status;
    if (job.status === 'running') job.progress = { value: 0.5, nodes_done: 10, nodes_total: 20, current_node_class: 'SamplerCustomAdvanced', step: 4, steps: 8 };
    if (job.status === 'succeeded') {
      job.completed_at = '2026-10-21T10:01:35Z';
      job.outputs = [{ node_id: '9', type: 'image', id: 'preview' }, { node_id: '60', type: job.type, content_type: `${job.type}/x`, id: `out-${job.id}` }];
    }
    if (job.status === 'failed') job.error = error;
    return reply(job);
  };
  return { fetchFn, calls, jobs };
}

const fast = { pollMs: 0, sleep: async () => {} };

test('comfyClient sends the key as a Bearer token to the chosen base only', async () => {
  const api = fakeComfy();
  const client = comfyClient({ base: 'https://relay.example.dev', key: 'comfyui-test', fetchFn: api.fetchFn });
  await client.check();
  assert.equal(api.calls[0].path, '/api/v2/jobs?limit=1');
  const asset = await client.upload(new Blob(['png'], { type: 'image/png' }), 'depth.png');
  assert.equal(asset.file_path, 'depth.png');
  const form = api.calls[1].body;
  assert.deepEqual([form.get('content_type'), form.get('file_path'), form.get('file').name], ['image/png', 'depth.png', 'depth.png']);
  assert.ok(api.calls.every((c) => c.headers.Authorization === 'Bearer comfyui-test'));
  assert.throws(() => comfyClient({ key: '' }), /API key/);
});

test('comfyClient explains refused keys, unreachable hosts and API errors', async () => {
  const api = fakeComfy();
  await assert.rejects(comfyClient({ key: 'wrong', fetchFn: api.fetchFn }).check(), /invalid API key \(the API key was refused/);
  const blocked = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(comfyClient({ key: 'k', fetchFn: blocked }).check(), /could not reach https:\/\/cloud\.comfy\.org.*CORS.*relay/);
  const broke = async () => reply({ error: { code: 'invalid_workflow', message: 'Node 12: missing input' } }, 422);
  const err = await comfyClient({ key: 'k', fetchFn: broke }).submit({}).catch((e) => e);
  assert.equal(err.message, 'Node 12: missing input');
  assert.equal(err.code, 'invalid_workflow');
});

test('the key goes in a header only: never the URL, no cookies, no Referer', async () => {
  const api = fakeComfy();
  const seen = [];
  const spy = async (url, init) => {
    seen.push({ url: String(url), init });
    return api.fetchFn(url, init);
  };
  const client = comfyClient({ base: 'https://relay.example.dev', key: 'comfyui-test', fetchFn: spy });
  await client.check();
  const job = await client.submit({ 60: { inputs: { video: [] } } });
  await client.getJob(job.id);
  await client.download('out-1');
  for (const { url, init } of seen) {
    assert.ok(url.startsWith('https://relay.example.dev/api/v2/'));
    assert.ok(!url.includes('comfyui-test'));
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
  }
});

test('error text on the page never carries the key and stays one short line', async () => {
  const key = 'comfyui-secret123';
  assert.equal(redact(`bad token ${key}\n<img src=x onerror=alert(1)>`, key), 'bad token [your key] <img src=x onerror=alert(1)>');
  assert.equal(redact('x'.repeat(1000), key).length, 300);
  const echo = async () => reply({ error: { message: `Bearer ${key} is not valid` } }, 401);
  const err = await comfyClient({ key, fetchFn: echo }).check().catch((e) => e);
  assert.doesNotMatch(err.message, /secret123/);
  assert.match(err.message, /\[your key\] is not valid/);
  // a browser network error that quotes the request is cleaned the same way
  const quoting = async (url, init) => { throw new TypeError(`Failed to fetch with ${init.headers.Authorization}`); };
  const net = await comfyClient({ key, fetchFn: quoting }).check().catch((e) => e);
  assert.doesNotMatch(net.message, /secret123/);
  // a key with a stray newline would make fetch throw "invalid header value: Bearer <key>": refused first
  assert.throws(() => comfyClient({ key: `${key}\n` }), /spaces or unusual characters/);
  assert.throws(() => comfyClient({ key: 'comfy ui' }), /spaces/);
  // non-JSON and odd error bodies still give a status line
  const html = async () => new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' });
  assert.equal((await comfyClient({ key, fetchFn: html }).check().catch((e) => e)).message, '502 Bad Gateway');
  const nul = async () => new Response('null', { status: 500, statusText: 'Server Error' });
  assert.equal((await comfyClient({ key, fetchFn: nul }).check().catch((e) => e)).message, '500 Server Error');
});

test('cloudRender uploads both files, submits once with an idempotency key, polls, downloads node 60', async () => {
  const api = fakeComfy();
  const client = comfyClient({ key: 'comfyui-test', fetchFn: api.fetchFn });
  const seen = [];
  const { blob, state } = await cloudRender(client, {
    mp4: new Blob(['mp4'], { type: 'video/mp4' }), look: new Blob(['png'], { type: 'image/png' }), lookName: 'look.jpg',
    prompt: 'a plaza', output: { width: 960, height: 576, frames: 65 }, seed: 9,
  }, { ...fast, onUpdate: (s) => seen.push(describeState(s)) });
  assert.equal(await blob.text(), `bytes of out-${state.id}`);
  assert.equal(state.seconds, 95);
  const paths = api.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['POST /api/v2/assets', 'POST /api/v2/assets', 'POST /api/v2/jobs', `GET /api/v2/jobs/${state.id}`,
    `GET /api/v2/jobs/${state.id}`, `GET /api/v2/assets/out-${state.id}/content`]);
  const submit = api.calls[2];
  assert.ok(submit.headers['Idempotency-Key']);
  const wf = JSON.parse(submit.body).workflow;
  assert.deepEqual(wf[NODES.layout].inputs.file.info, { id: 'asset-1', file_path: 'layout.mp4' });
  assert.deepEqual(wf[NODES.look].inputs.image.info, { id: 'asset-2', file_path: 'look.jpg' });
  assert.equal(wf[NODES.seed].inputs.noise_seed, 9);
  assert.match(seen[0], /^Uploading/);
  assert.equal(seen[1], 'Waiting for the GPU…');
  assert.match(seen[2], /^Rendering 50% · SamplerCustomAdvanced, step 4\/8/);
  assert.equal(seen.at(-1), 'Done in 95s');
});

test('cloudLook gets the still from the SaveImage node', async () => {
  const api = fakeComfy();
  const client = comfyClient({ key: 'comfyui-test', fetchFn: api.fetchFn });
  const { state } = await cloudLook(client, { depth: new Blob(['png'], { type: 'image/png' }), prompt: 'a plaza', output: { width: 960, height: 576 }, seed: 3 }, fast);
  assert.equal(api.calls.at(-1).path, `/api/v2/assets/out-${state.id}/content`);
  await assert.rejects(cloudLook(client, { depth: new Blob([]), prompt: 'p', output: { width: 1000, height: 576 } }, fast), /divisible by 64/);
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 2); // the bad size uploaded nothing
});

test('failed and cancelled jobs throw with the node error', async () => {
  const api = fakeComfy({ finish: 'failed', error: { code: 'node_execution_error', message: 'CUDA out of memory', node_id: '44', class_type: 'SamplerCustomAdvanced' } });
  const client = comfyClient({ key: 'comfyui-test', fetchFn: api.fetchFn });
  await assert.rejects(runCloudJob(client, { 60: { inputs: {} } }, { kind: 'render', outputNode: '60', type: 'video', ...fast }),
    /CUDA out of memory \(node 44 SamplerCustomAdvanced\)/);
  assert.equal(describeState(panelState({ id: 'j', status: 'canceled' }, 'render')), 'Cancelled');
  assert.equal(panelState({ id: 'j', status: 'expired' }, 'look').status, 'failed');
  assert.equal(panelState({ id: 'j', status: 'canceling' }, 'look').status, 'running');
  const none = fakeComfy();
  const graph = { 60: { inputs: { images: [] } } };
  const noOutput = async (url, init) => {
    const res = await none.fetchFn(url, init);
    if (!url.includes('/jobs/')) return res;
    const job = await res.json();
    return reply({ ...job, outputs: job.outputs.filter((o) => o.node_id !== '60') });
  };
  await assert.rejects(runCloudJob(comfyClient({ key: 'comfyui-test', fetchFn: noOutput }), graph, { kind: 'look', outputNode: '60', type: 'image', ...fast }),
    /without an image from node 60/);
});

test('Cancel stops a cloud job: nothing sent before the submit, the job cancelled after it', async () => {
  const calls = [];
  const ctl = new AbortController();
  const client = {
    upload: async () => (calls.push('upload'), { id: 'a1' }),
    submit: async () => (calls.push('submit'), ctl.abort(), { id: 'j1', status: 'pending' }), // Cancel lands mid-submit
    getJob: async () => (calls.push('get'), { id: 'j1', status: 'in_progress' }),
    cancel: async (id) => (calls.push(`cancel ${id}`), {}),
  };
  const graph = { 60: { inputs: {} } };
  await assert.rejects(runCloudJob(client, graph, { kind: 'render', outputNode: '60', type: 'video', sleep: async () => {}, signal: ctl.signal }),
    /render cancelled/);
  assert.deepEqual(calls, ['submit', 'cancel j1']);
  calls.length = 0;
  await assert.rejects(cloudLook(client, { depth: new Blob(['png']), prompt: 'a plaza', output: { width: 960, height: 576 } }, { signal: ctl.signal }),
    /look cancelled/);
  assert.deepEqual(calls, []); // already cancelled: no upload, no submit
});

test('abortableSleep ends early on abort and removes its listener', async () => {
  const ctl = new AbortController();
  let listeners = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const remove = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = (...a) => (listeners++, add(...a));
  ctl.signal.removeEventListener = (...a) => (listeners--, remove(...a));
  const t0 = Date.now();
  await abortableSleep(5, ctl.signal); // ends by its timer
  assert.equal(listeners, 0);
  const long = abortableSleep(60_000, ctl.signal);
  ctl.abort();
  await long;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(listeners, 0);
  await abortableSleep(60_000, ctl.signal); // already aborted: no wait at all
});

// A sleep that never ends by itself, only when the signal aborts: a runCloudJob that waits out the poll hangs here.
const onlyOnAbort = (ms, signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

test('Cancel reaches a cloud job at once, not at the next poll', async () => {
  const calls = [];
  const ctl = new AbortController();
  const client = {
    submit: async () => (calls.push('submit'), { id: 'j2', status: 'in_progress' }),
    getJob: async () => (calls.push('get'), { id: 'j2', status: 'in_progress' }),
    cancel: async (id) => (calls.push(`cancel ${id}`), { id, status: 'canceling' }),
  };
  const run = runCloudJob(client, { 60: { inputs: {} } }, { kind: 'render', outputNode: '60', type: 'video', pollMs: 60_000, sleep: onlyOnAbort, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  await assert.rejects(run, /render cancelled/);
  assert.deepEqual(calls, ['submit', 'cancel j2']);
});

test('a cloud job that finished before the cancel landed is kept', async () => {
  const calls = [];
  const ctl = new AbortController();
  const done = { id: 'j3', status: 'succeeded', outputs: [{ node_id: '60', type: 'image', id: 'out-j3' }] };
  const client = {
    submit: async () => (calls.push('submit'), { id: 'j3', status: 'running' }),
    getJob: async () => (calls.push('get'), done),
    cancel: async () => {
      calls.push('cancel');
      throw Object.assign(new Error('job already finished'), { status: 409 });
    },
    download: async (id) => (calls.push(`download ${id}`), new Blob(['png'])),
  };
  const seen = [];
  const run = runCloudJob(client, { 60: { inputs: {} } }, {
    kind: 'look', outputNode: '60', type: 'image', sleep: onlyOnAbort, signal: ctl.signal, onUpdate: (s) => seen.push(s.status),
  });
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  const { blob, state } = await run;
  assert.equal(await blob.text(), 'png');
  assert.equal(state.status, 'succeeded');
  assert.deepEqual(calls, ['submit', 'cancel', 'get', 'download out-j3']);
  assert.deepEqual(seen, ['running', 'succeeded']);
});

test('cancel posts to the job', async () => {
  const api = fakeComfy();
  const client = comfyClient({ key: 'comfyui-test', fetchFn: api.fetchFn });
  const job = await client.submit({ 60: { inputs: { video: [] } } });
  const res = await client.cancel(job.id);
  assert.equal(res.status, 'canceling');
  assert.equal(api.calls.at(-1).path, `/api/v2/jobs/${job.id}/cancel`);
});
