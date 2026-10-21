// Comfy API pass-through for the live page (web/ on GitHub Pages): browsers can't call Comfy Cloud
// directly (no CORS headers), so this Worker forwards the few Comfy API v2 calls the page makes to
// Comfy Cloud and adds CORS headers for the allowlisted page origins. Each visitor's own key rides through in the Authorization header.
//
// It stores nothing and logs nothing: no KV/D1/R2 bindings, no console calls, no analytics. Keep it so.
// Setup and deploy steps: docs/LIVE_RENDER.md. Threat model and review: docs/SECURITY.md.

const DEFAULT_UPSTREAM = 'https://cloud.comfy.org';
// Request headers passed upstream; everything else (cookies, CF-*, X-Forwarded-*) is dropped.
const PASS_REQUEST = ['authorization', 'content-type', 'idempotency-key', 'accept', 'range', 'if-none-match'];
// Response headers the page may read.
const EXPOSE = 'Retry-After, Content-Range, Content-Length, Content-Type, ETag, X-Request-Id';
const DROP_RESPONSE = ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-expose-headers', 'access-control-allow-headers', 'access-control-allow-methods'];

// The only calls the page makes (web/src/cloud.js). Anything else is refused here, so the relay can't be
// used as a general proxy into the Comfy API, let alone to any other host.
const ID = '[A-Za-z0-9_-]{1,128}';
const ROUTES = [
  ['GET', new RegExp('^/api/v2/jobs$')],
  ['POST', new RegExp('^/api/v2/jobs$')],
  ['GET', new RegExp(`^/api/v2/jobs/${ID}$`)],
  ['POST', new RegExp(`^/api/v2/jobs/${ID}/cancel$`)],
  ['POST', new RegExp('^/api/v2/assets$')],
  ['GET', new RegExp(`^/api/v2/assets/${ID}/content$`)],
];
const CONTENT = new RegExp(`^/api/v2/assets/${ID}/content$`);
// Uploads are a playblast MP4 or a PNG still: a few MB. Cloudflare's own cap is 100 MB.
export const MAX_BODY = 50 * 1024 * 1024;

const routeAllows = (method, path) => ROUTES.some(([m, re]) => m === method && re.test(path));

/** The request body, buffered, or null when it is over `max` bytes (stops reading as soon as it is). */
async function readCapped(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > max) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSE,
    Vary: 'Origin',
  };
}

function json(status, code, message, origin) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status, headers: { 'Content-Type': 'application/json', ...(origin ? cors(origin) : {}) },
  });
}

/** Handle one request. `fetchFn` is the global fetch in the Worker (a stub in tests). */
export async function handle(request, env = {}, fetchFn = fetch) {
  const origin = request.headers.get('Origin');
  const ok = origin && allowedOrigins(env).has(origin);
  if (!ok) return json(403, 'forbidden', 'this relay only serves the Open Cinema Studio page', null);

  const url = new URL(request.url);
  const path = url.pathname;
  if (!ROUTES.some(([, re]) => re.test(path))) return json(404, 'not_found', 'only the Comfy API v2 calls the page makes are relayed', origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(origin),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, Range',
        'Access-Control-Max-Age': '600',
      },
    });
  }

  if (!routeAllows(request.method, path)) return json(405, 'method_not_allowed', `${request.method} ${path} is not relayed`, origin);
  if (!/^Bearer \S+$/.test(request.headers.get('Authorization') || '')) {
    return json(401, 'unauthorized', 'send your own Comfy API key (Authorization: Bearer ...)', origin);
  }

  const upstream = String(env.UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const headers = new Headers();
  for (const name of PASS_REQUEST) {
    const v = request.headers.get(name);
    if (v != null) headers.set(name, v);
  }
  let body;
  if (request.method === 'POST') {
    // Buffered so the body is plain bytes upstream, and capped (uploads are a few MB: a playblast or a still).
    body = await readCapped(request, MAX_BODY);
    if (body === null) return json(413, 'too_large', `uploads over ${MAX_BODY / 1024 / 1024} MB are not relayed`, origin);
  }
  let res;
  try {
    res = await fetchFn(`${upstream}${path}${url.search}`, { method: request.method, headers, body, redirect: 'manual' });
    // GET /assets/{id}/content answers with a redirect to signed storage, which has no CORS headers
    // either: fetch it here, without the key (the signed URL is the credential). Only that call, and
    // only to https, so an odd upstream answer can't point the relay somewhere else.
    const location = res.headers.get('Location');
    if (CONTENT.test(path) && res.status >= 300 && res.status < 400 && location) {
      const target = new URL(location, upstream);
      if (target.protocol !== 'https:') return json(502, 'bad_redirect', 'upstream redirected the download to a non-https URL', origin);
      const range = request.headers.get('Range');
      res = await fetchFn(target.toString(), { headers: range ? { Range: range } : {} });
    }
  } catch {
    return json(502, 'upstream_unreachable', `could not reach ${upstream}`, origin);
  }

  const out = new Headers(res.headers);
  for (const name of DROP_RESPONSE) out.delete(name);
  for (const [k, v] of Object.entries(cors(origin))) out.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export default { fetch: (request, env) => handle(request, env) };
