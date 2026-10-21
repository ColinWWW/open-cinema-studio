// worker/ (the Comfy API pass-through for the live page), run against a stubbed upstream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import worker, { MAX_BODY, handle } from '../../worker/src/index.js';

const PAGE = 'https://colinwww.github.io';
const env = { ALLOWED_ORIGINS: `${PAGE}, http://localhost:5173/`, UPSTREAM: 'https://cloud.example' };
const KEY = { Authorization: 'Bearer comfyui-test' };
const req = (path, init = {}, origin = PAGE) => new Request(`https://relay.example${path}`, {
  ...init, headers: { ...(origin ? { Origin: origin } : {}), ...KEY, ...init.headers },
});

function upstream(answer = () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b' } })) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body, redirect: init.redirect });
    return answer(String(url), init);
  };
  return { fetchFn, calls };
}

test('only allowlisted page origins get through', async () => {
  const up = upstream();
  assert.equal((await handle(req('/api/v2/jobs', {}, 'https://evil.example'), env, up.fetchFn)).status, 403);
  assert.equal((await handle(req('/api/v2/jobs', {}, null), env, up.fetchFn)).status, 403);
  const res = await handle(req('/api/v2/jobs', {}, 'http://localhost:5173'), env, up.fetchFn);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assert.equal(up.calls.length, 1);
  assert.equal((await handle(req('/api/v2/jobs'), {}, up.fetchFn)).status, 403); // nothing allowed by default
});

test('preflight answers locally with the headers the page sends', async () => {
  const up = upstream();
  const res = await handle(req('/api/v2/jobs', { method: 'OPTIONS' }), env, up.fetchFn);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGE);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization.*Idempotency-Key/);
  assert.equal(res.headers.get('Vary'), 'Origin');
  assert.equal(up.calls.length, 0);
});

test('requests pass through with the key and nothing else of the browser', async () => {
  const up = upstream();
  const res = await handle(req('/api/v2/jobs?limit=1', {
    method: 'POST', body: '{"workflow":{}}',
    headers: { Authorization: 'Bearer comfyui-test', 'Content-Type': 'application/json', 'Idempotency-Key': 'k1', Cookie: 'session=1', 'CF-Connecting-IP': '1.2.3.4' },
  }), env, up.fetchFn);
  const [call] = up.calls;
  assert.equal(call.url, 'https://cloud.example/api/v2/jobs?limit=1');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'manual');
  assert.equal(new TextDecoder().decode(call.body), '{"workflow":{}}');
  assert.deepEqual([...call.headers.keys()].sort(), ['authorization', 'content-type', 'idempotency-key']);
  assert.equal(call.headers.get('authorization'), 'Bearer comfyui-test');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGE);
  assert.equal(res.headers.get('Set-Cookie'), null);
  assert.deepEqual(await res.json(), { ok: true });
});

test('downloads follow the signed-storage redirect without the key', async () => {
  const up = upstream((url) => (url.startsWith('https://cloud.example')
    ? new Response(null, { status: 302, headers: { Location: 'https://storage.example/out.mp4?sig=abc' } })
    : new Response('mp4 bytes', { headers: { 'Content-Type': 'video/mp4' } })));
  const res = await handle(req('/api/v2/assets/a1/content', { headers: { Authorization: 'Bearer comfyui-test' } }), env, up.fetchFn);
  assert.equal(await res.text(), 'mp4 bytes');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGE);
  assert.equal(up.calls[1].url, 'https://storage.example/out.mp4?sig=abc');
  assert.equal(up.calls[1].headers.get('authorization'), null);
});

test('upstream errors keep their status and gain CORS; an unreachable upstream is a 502', async () => {
  const up = upstream(() => new Response('{"error":{"code":"unauthorized","message":"bad key"}}', { status: 401 }));
  const res = await handle(req('/api/v2/jobs'), env, up.fetchFn);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGE);
  const down = await handle(req('/api/v2/jobs'), env, async () => { throw new Error('dns'); });
  assert.equal(down.status, 502);
  assert.equal(down.headers.get('Access-Control-Allow-Origin'), PAGE);
  assert.equal((await down.json()).error.code, 'upstream_unreachable');
});

test('only /api/v2 is relayed, and the module exports a Workers fetch handler', async () => {
  const up = upstream();
  assert.equal((await handle(req('/api/prompt'), env, up.fetchFn)).status, 404);
  assert.equal(up.calls.length, 0);
  assert.equal(typeof worker.fetch, 'function');
});

test('only the calls the page makes are relayed: routes, methods and ids are allowlisted', async () => {
  const up = upstream();
  const status = async (path, method = 'GET') => (await handle(req(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) }), env, up.fetchFn)).status;
  for (const [path, method] of [['/api/v2/jobs?limit=1'], ['/api/v2/jobs', 'POST'], ['/api/v2/jobs/job-1'],
    ['/api/v2/jobs/job-1/cancel', 'POST'], ['/api/v2/assets', 'POST'], ['/api/v2/assets/a_1/content']]) {
    assert.equal(await status(path, method), 200, `${method || 'GET'} ${path}`);
  }
  const allowed = up.calls.length;
  assert.equal(await status('/api/v2/workspaces'), 404); // other v2 endpoints
  assert.equal(await status('/api/v2/jobs/job-1/events'), 404);
  assert.equal(await status('/api/v2/assets/a1'), 404);
  assert.equal(await status('/api/v2/jobs/a%2F..%2Fb'), 404); // encoded slashes are not ids
  assert.equal(await status('/api/v2/jobs/..%2f..%2fadmin'), 404);
  assert.equal(await status('/api/v2/jobs/job-1', 'DELETE'), 405);
  assert.equal(await status('/api/v2/jobs/job-1', 'PUT'), 405);
  assert.equal(await status('/api/v2/assets/a1/content', 'POST'), 405);
  assert.equal(up.calls.length, allowed);
  const pre = await handle(req('/api/v2/jobs', { method: 'OPTIONS' }), env, up.fetchFn);
  assert.doesNotMatch(pre.headers.get('Access-Control-Allow-Methods'), /DELETE|PUT/);
  assert.equal((await handle(req('/api/v2/workspaces', { method: 'OPTIONS' }), env, up.fetchFn)).status, 404);
  // every call goes to the configured upstream host, whatever the path looks like
  assert.ok(up.calls.every((c) => c.url.startsWith('https://cloud.example/api/v2/')));
});

test('requests without a key are refused here, so the relay is never anonymous', async () => {
  const up = upstream();
  const bare = new Request('https://relay.example/api/v2/jobs', { headers: { Origin: PAGE } });
  const res = await handle(bare, env, up.fetchFn);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PAGE);
  const basic = await handle(req('/api/v2/jobs', { headers: { Authorization: 'Basic dTpw' } }), env, up.fetchFn);
  assert.equal(basic.status, 401);
  assert.equal(up.calls.length, 0);
});

test('uploads over the size cap are refused before anything goes upstream', async () => {
  const up = upstream();
  const declared = await handle(req('/api/v2/assets', { method: 'POST', body: 'x', headers: { 'Content-Length': String(MAX_BODY + 1) } }), env, up.fetchFn);
  assert.equal(declared.status, 413);
  // a streamed body with no length is cut off as soon as it passes the cap
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      sent += 1024 * 1024;
      if (sent > MAX_BODY + 4 * 1024 * 1024) return c.close();
      c.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const streamed = await handle(req('/api/v2/assets', { method: 'POST', body: stream, duplex: 'half' }), env, up.fetchFn);
  assert.equal(streamed.status, 413);
  assert.equal(streamed.headers.get('Access-Control-Allow-Origin'), PAGE);
  assert.ok(sent <= MAX_BODY + 2 * 1024 * 1024, 'stopped reading early');
  assert.equal(up.calls.length, 0);
  const small = await handle(req('/api/v2/assets', { method: 'POST', body: 'png bytes' }), env, up.fetchFn);
  assert.equal(small.status, 200);
  assert.equal(new TextDecoder().decode(up.calls[0].body), 'png bytes');
});

test('only the download redirect is followed, and only to https', async () => {
  const redirect = (to) => upstream((url) => (url.startsWith('https://cloud.example')
    ? new Response(null, { status: 302, headers: { Location: to } })
    : new Response('elsewhere')));
  const plain = redirect('http://storage.example/out.mp4');
  assert.equal((await handle(req('/api/v2/assets/a1/content'), env, plain.fetchFn)).status, 502);
  assert.equal(plain.calls.length, 1);
  const jobs = redirect('https://internal.example/admin');
  const res = await handle(req('/api/v2/jobs/job-1'), env, jobs.fetchFn);
  assert.equal(res.status, 302); // passed back as is, not fetched by the relay
  assert.equal(jobs.calls.length, 1);
});

test('the relay has no logging and no storage', () => {
  const src = fs.readFileSync(new URL('../../worker/src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /console\.|caches\.|\.put\(|waitUntil/);
  const toml = fs.readFileSync(new URL('../../worker/wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(toml, /kv_namespaces|d1_databases|r2_buckets|durable_objects|analytics_engine|logpush|tail_consumers/);
  assert.match(toml, /\[observability\]\s*\nenabled = false/);
});
