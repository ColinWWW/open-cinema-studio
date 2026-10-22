import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiUrl, aspectWarning, checkHealth, describeState, loadServer, lookForm, normalizeServer, promptWarnings, renderForm,
  cancelJob, fetchBlob, MAX_SEQUENCE_SHOTS, parseSeed, renderAllBlock, renderShots, runJob, runRender, saveServer,
  serverCommand, stitchShots,
} from '../src/render.js';

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
  assert.equal(describeState({ status: 'cancelled', error: 'cancelled' }), 'Cancelled');
  assert.match(describeState({ status: 'running', stage: 'rendering', progress: 0.5, node: 'Sample stage 2', step: 2, steps: 3 }),
    /^Rendering 50% · Sample stage 2, step 2\/3 \(/);
});

test('cancelJob posts to the job and accepts one that already ended', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts.method]);
    return new Response(JSON.stringify({ status: url.includes('done') ? 'succeeded' : 'cancelled' }), { status: url.includes('done') ? 409 : 200 });
  };
  assert.equal((await cancelJob('render', 'abc', { server: 'http://h:8190', fetchFn })).status, 'cancelled');
  assert.deepEqual(calls[0], ['http://h:8190/api/render/abc/cancel', 'POST']);
  assert.equal((await cancelJob('look', 'done', { fetchFn })).status, 'succeeded');
});

test('runJob sends nothing when cancelled before the submit', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => (calls.push([url, opts?.method || 'GET']), reply({ id: 'x', status: 'queued' }));
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(runJob('render', new FormData(), { fetchFn, sleep: async () => {}, signal: ctl.signal }), /render cancelled/);
  assert.deepEqual(calls, []);
});

test('runJob cancels the job it submitted when Cancel comes after the submit', async () => {
  // Cancel pressed while the POST is in flight (e.g. between Render all shots): the new job must not keep the GPU busy.
  const ctl = new AbortController();
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts?.method || 'GET']);
    if (url === '/api/look') {
      ctl.abort();
      return reply({ id: 'l9', status: 'queued' }, 202);
    }
    return reply({ id: 'l9', status: 'cancelled' });
  };
  const seen = [];
  await assert.rejects(
    runJob('look', new FormData(), { fetchFn, sleep: async () => {}, signal: ctl.signal, onUpdate: (s) => seen.push(s.status) }),
    /look cancelled/,
  );
  assert.deepEqual(calls, [['/api/look', 'POST'], ['/api/look/l9/cancel', 'POST']]);
  assert.deepEqual(seen, ['queued']);
});

test('runJob cancels a running job between polls, even if the cancel request fails', async () => {
  const ctl = new AbortController();
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts?.method || 'GET']);
    if (url === '/api/render') return reply({ id: 'r7', status: 'queued' }, 202);
    if (url.endsWith('/cancel')) throw new TypeError('Failed to fetch');
    return reply({ id: 'r7', status: 'running', stage: 'rendering', progress: 0.3 });
  };
  const sleep = async () => {
    if (calls.length >= 2) ctl.abort(); // after the first poll
  };
  await assert.rejects(runRender(new FormData(), { fetchFn, sleep, signal: ctl.signal }), /render cancelled/);
  assert.deepEqual(calls, [['/api/render', 'POST'], ['/api/render/r7', 'GET'], ['/api/render/r7/cancel', 'POST']]);
});

// A sleep that never ends by itself, only when the signal aborts: a runJob that waits out the poll hangs here.
const onlyOnAbort = (ms, signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

test('runJob sends the cancel the moment Cancel is pressed, not at the next poll', async () => {
  const ctl = new AbortController();
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts?.method || 'GET']);
    if (url === '/api/render') return reply({ id: 'r3', status: 'running', progress: 0.2 }, 202);
    return reply({ id: 'r3', status: 'cancelled' });
  };
  const run = runRender(new FormData(), { fetchFn, pollMs: 60_000, sleep: onlyOnAbort, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10)); // the job is mid-poll-wait
  ctl.abort();
  await assert.rejects(run, /render cancelled/);
  assert.deepEqual(calls, [['/api/render', 'POST'], ['/api/render/r3/cancel', 'POST']]);
});

test('runJob keeps a job that succeeded before the cancel landed', async () => {
  const ctl = new AbortController();
  const done = { id: 'l4', status: 'succeeded', image_url: '/api/look/l4/image', seconds: 3.1 };
  const fetchFn = async (url) => {
    if (url === '/api/look') return reply({ id: 'l4', status: 'running' }, 202);
    return reply({ error: 'job is already succeeded', ...done }, 409); // the server's answer to a late cancel
  };
  const seen = [];
  const run = runJob('look', new FormData(), { fetchFn, sleep: onlyOnAbort, signal: ctl.signal, onUpdate: (s) => seen.push(s.status) });
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  const final = await run;
  assert.equal(final.status, 'succeeded');
  assert.equal(final.image_url, '/api/look/l4/image');
  assert.deepEqual(seen, ['running', 'succeeded']);
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

test('normalizeServer cleans up typed URLs', () => {
  assert.equal(normalizeServer(''), '');
  assert.equal(normalizeServer('   '), '');
  assert.equal(normalizeServer('http://127.0.0.1:8190/'), 'http://127.0.0.1:8190');
  assert.equal(normalizeServer(' 127.0.0.1:8190 '), 'http://127.0.0.1:8190');
  assert.equal(normalizeServer('https://abc-8190.proxy.runpod.net'), 'https://abc-8190.proxy.runpod.net');
  assert.equal(normalizeServer('https://example.com/ocs//'), 'https://example.com/ocs'); // behind a path prefix
  assert.throws(() => normalizeServer('ftp://example.com'), /http/);
  assert.throws(() => normalizeServer('http://example.com/?x=1'), /query/);
  assert.throws(() => normalizeServer('http://exa mple.com'));
});

test('apiUrl prefixes API paths with the render server', () => {
  assert.equal(apiUrl('', '/api/health'), '/api/health'); // same origin (Vite proxy)
  assert.equal(apiUrl('http://127.0.0.1:8190', '/api/render/r1/video'), 'http://127.0.0.1:8190/api/render/r1/video');
  assert.equal(apiUrl('https://example.com/ocs', 'api/look'), 'https://example.com/ocs/api/look');
  assert.equal(apiUrl('http://a', 'https://cdn.example/x.mp4'), 'https://cdn.example/x.mp4');
});

test('loadServer/saveServer remember the URL and survive blocked storage', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  assert.equal(loadServer(storage), '');
  saveServer('http://127.0.0.1:8190', storage);
  assert.equal(loadServer(storage), 'http://127.0.0.1:8190');
  saveServer('', storage);
  assert.equal(loadServer(storage), '');
  data.set('ocs.renderServer', 'ftp://nope');
  assert.equal(loadServer(storage), ''); // bad saved value -> same origin
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  assert.equal(loadServer(blocked), '');
  assert.doesNotThrow(() => saveServer('http://x', blocked));
  assert.equal(loadServer(undefined), '');
});

test('runJob talks to the configured render server', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return url.endsWith('/api/look') ? reply({ id: 'l1', status: 'queued' }, 202) : reply({ id: 'l1', status: 'succeeded' });
  };
  await runJob('look', new FormData(), { server: 'http://pod:8190', fetchFn, sleep: async () => {} });
  assert.deepEqual(calls, ['http://pod:8190/api/look', 'http://pod:8190/api/look/l1']);
});

test('checkHealth accepts only our server', async () => {
  const urls = [];
  const ok = async (url) => (urls.push(url), reply({ ok: true, target: 'AsyncComfy(...)' }));
  assert.equal((await checkHealth('http://127.0.0.1:8190', { fetchFn: ok })).target, 'AsyncComfy(...)');
  assert.deepEqual(urls, ['http://127.0.0.1:8190/api/health']);
  await assert.rejects(checkHealth('', { fetchFn: async () => reply({}, 404) }), /404/); // GitHub Pages
  await assert.rejects(checkHealth('', { fetchFn: async () => reply({}) }), /not an Open Cinema Studio/); // SPA fallback page
  await assert.rejects(checkHealth('http://x', { fetchFn: async () => { throw new TypeError('Failed to fetch'); } }), /Failed to fetch/);
});

test('serverCommand names the page origin unless the dev server proxies', () => {
  assert.equal(serverCommand('http://localhost:5173', { proxied: true }), 'python -m server.app');
  assert.equal(serverCommand('https://colinwww.github.io'), 'python -m server.app --cors-origin https://colinwww.github.io');
});

test('stitchShots posts the render ids and returns the sequence', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push([url, opts.method, opts.headers['Content-Type'], JSON.parse(opts.body)]);
    return reply({ id: 's1', status: 'succeeded', video_url: '/api/sequence/s1/video', frames: 130 }, 201);
  };
  const seq = await stitchShots(['a', 'b'], { server: 'http://pod:8190', clip: 'layout', fetchFn });
  assert.equal(seq.video_url, '/api/sequence/s1/video');
  assert.deepEqual(calls, [['http://pod:8190/api/stitch', 'POST', 'application/json', { renders: ['a', 'b'], clip: 'layout' }]]);
  await assert.rejects(stitchShots(['a'], { fetchFn: async () => reply({ error: 'send 2 to 24 render ids' }, 400) }), /2 to 24/);
  await assert.rejects(stitchShots(['a', 'b'], { fetchFn: async () => reply({ status: 'failed', error: 'ffmpeg could not join' }, 500) }), /ffmpeg/);
});

test('runJob rides out dropped polls and proxy 5xx, but not a missing job', async () => {
  const replies = [
    () => { throw new TypeError('Failed to fetch'); },
    () => reply({ error: 'bad gateway' }, 502),
    () => reply({ id: 'r3', status: 'succeeded', video_url: '/api/render/r3/video' }),
  ];
  const waits = [];
  const fetchFn = async (url) => (url === '/api/render' ? reply({ id: 'r3', status: 'queued' }) : replies.shift()());
  const final = await runRender(new FormData(), { fetchFn, pollMs: 10, sleep: async (ms) => waits.push(ms) });
  assert.equal(final.status, 'succeeded');
  assert.deepEqual(waits, [10, 10, 20]); // the poll interval, then backoff on each retry

  const gone = async (url) => (url === '/api/render' ? reply({ id: 'r4', status: 'queued' }) : reply({ error: 'unknown job' }, 404));
  await assert.rejects(runRender(new FormData(), { fetchFn: gone, sleep: async () => {} }), /unknown job/);

  const down = async (url) => {
    if (url === '/api/render') return reply({ id: 'r5', status: 'queued' });
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(runRender(new FormData(), { fetchFn: down, retries: 2, sleep: async () => {} }), /Failed to fetch/);
});

test('fetchBlob throws on an error reply instead of returning it as the file', async () => {
  const ok = async (url) => new Response('mp4', { status: 200, headers: { 'X-Url': url } });
  assert.equal(await (await fetchBlob('http://h:8190', '/api/render/r1/video', { fetchFn: ok })).text(), 'mp4');
  const missing = async () => new Response(JSON.stringify({ error: 'no result yet' }), { status: 404 });
  await assert.rejects(fetchBlob('', '/api/render/r1/video', { fetchFn: missing }), /no result yet/);
});

test('parseSeed keeps 0 and falls back to 42 for anything else', () => {
  assert.equal(parseSeed('0'), 0);
  assert.equal(parseSeed('7'), 7);
  for (const bad of ['', '  ', 'abc', '-1', '1.5', undefined]) assert.equal(parseSeed(bad), 42);
});

test('renderAllBlock stops Render all over the 24 shots /api/stitch accepts, and says why', () => {
  assert.equal(MAX_SEQUENCE_SHOTS, 24);
  assert.equal(renderAllBlock(2, 'server'), null);
  assert.equal(renderAllBlock(24, 'server'), null);
  assert.match(renderAllBlock(25, 'server'), /at most 24 shots.*remove 1/);
  assert.match(renderAllBlock(30, 'server'), /remove 6/);
  assert.match(renderAllBlock(1, 'server'), /Add shots/);
  assert.match(renderAllBlock(3, 'cloud'), /render server/);
});

test('renderShots uses the seed the run began with for every look and render', async () => {
  const posted = [];
  let n = 0;
  const fetchFn = async (url, opts) => {
    if (opts?.method === 'POST') {
      posted.push([url, opts.body.get('seed')]);
      const id = `j${++n}`;
      return reply(url === '/api/look' ? { id, status: 'succeeded', image_url: `/api/look/${id}/image` }
        : { id, status: 'succeeded', video_url: `/api/render/${id}/video` }, 202);
    }
    return { ok: true, status: 200, blob: async () => new Blob(['png']) };
  };
  let typed = 7; // what the seed field says; a real run reads it once, so later edits don't matter
  const looks = [];
  const ids = await renderShots(2, {
    prompt: 'a plaza', seed: typed, fetchFn, sleep: async () => {},
    prepare: async (i) => {
      typed = 99;
      return { stem: `shot${i + 1}`, depth: new Blob(['d']), mp4: new Blob(['m']), output: { width: 960, height: 576, frames: 65 } };
    },
    onLook: (i, still, shot) => looks.push([i, shot.stem]),
  });
  assert.deepEqual(ids, ['j2', 'j4']);
  assert.deepEqual(posted, [['/api/look', '7'], ['/api/render', '7'], ['/api/look', '7'], ['/api/render', '7']]);
  assert.deepEqual(looks, [[0, 'shot1'], [1, 'shot2']]);
});

test('describeState uses the server-side elapsed time, not this browser\'s clock', () => {
  const created = Date.now() / 1000 - 3600; // a server clock an hour ahead of ours would make this look an hour old
  assert.match(describeState({ status: 'running', stage: 'uploading', created, elapsed: 12.4 }), /\(12s\)$/);
  assert.match(describeState({ status: 'running', stage: 'rendering', progress: 0.1, created, elapsed: 61 }), /\(61s\)$/);
  assert.match(describeState({ status: 'running', stage: 'uploading', elapsed: 0 }), /\(0s\)$/);
  // Comfy Cloud states carry no elapsed: fall back to created
  assert.match(describeState({ status: 'running', stage: 'uploading', created: Date.now() / 1000 - 5 }), /\(5s\)$/);
});

test('This computer: the target is remembered, and its server is the local stack (same origin behind the dev proxy)', async () => {
  const { LOCAL_SERVER, loadTarget, localServer, saveTarget } = await import('../src/render.js');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.equal(loadTarget(storage), 'server');
  saveTarget('local', storage);
  assert.equal(loadTarget(storage), 'local');
  saveTarget('server', storage);
  assert.equal(loadTarget(storage), 'server');
  store.set('ocs.renderTarget', 'nonsense');
  assert.equal(loadTarget(storage), 'server');
  assert.equal(LOCAL_SERVER, 'http://127.0.0.1:8190');
  assert.equal(localServer(), LOCAL_SERVER);
  assert.equal(localServer({ proxied: true }), '');
});
