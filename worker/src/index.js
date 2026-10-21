// Comfy API pass-through for the live page (web/ on GitHub Pages): browsers can't call Comfy Cloud
// directly (no CORS headers), so this Worker forwards /api/v2/* to Comfy Cloud and adds CORS headers
// for the allowlisted page origins. Each visitor's own key rides through in the Authorization header.
//
// It stores nothing and logs nothing: no KV/D1/R2 bindings, no console calls, no analytics. Keep it so.
// Setup and deploy steps: docs/LIVE_RENDER.md.

const DEFAULT_UPSTREAM = 'https://cloud.comfy.org';
// Request headers passed upstream; everything else (cookies, CF-*, X-Forwarded-*) is dropped.
const PASS_REQUEST = ['authorization', 'content-type', 'idempotency-key', 'accept', 'range', 'if-none-match'];
// Response headers the page may read.
const EXPOSE = 'Retry-After, Content-Range, Content-Length, Content-Type, ETag, X-Request-Id';
const DROP_RESPONSE = ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-expose-headers', 'access-control-allow-headers', 'access-control-allow-methods'];

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
  if (!url.pathname.startsWith('/api/v2/')) return json(404, 'not_found', 'only /api/v2/* is relayed', origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(origin),
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, Range',
        'Access-Control-Max-Age': '600',
      },
    });
  }

  const upstream = String(env.UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const headers = new Headers();
  for (const name of PASS_REQUEST) {
    const v = request.headers.get(name);
    if (v != null) headers.set(name, v);
  }
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  let res;
  try {
    // Buffered so the body is plain bytes upstream (uploads are a few MB: a playblast or a still).
    const body = hasBody ? await request.arrayBuffer() : undefined;
    res = await fetchFn(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: 'manual' });
    // GET /assets/{id}/content answers with a redirect to signed storage, which has no CORS headers
    // either: fetch it here, without the key (the signed URL is the credential).
    const location = res.headers.get('Location');
    if (request.method === 'GET' && res.status >= 300 && res.status < 400 && location) {
      const range = request.headers.get('Range');
      res = await fetchFn(new URL(location, upstream).toString(), { headers: range ? { Range: range } : {} });
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
