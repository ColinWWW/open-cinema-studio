// worker/ (the Comfy API pass-through for the live page), run against a stubbed upstream.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { handle } from '../../worker/src/index.js';

const PAGE = 'https://colinwww.github.io';
const env = { ALLOWED_ORIGINS: `${PAGE}, http://localhost:5173/`, UPSTREAM: 'https://cloud.example' };
const req = (path, init = {}, origin = PAGE) => new Request(`https://relay.example${path}`, {
  ...init, headers: { ...(origin ? { Origin: origin } : {}), ...init.headers },
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
