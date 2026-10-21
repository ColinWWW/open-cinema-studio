// Share a scene as a link: the scene JSON (what Save downloads) is deflated and put in the URL hash as base64url,
// so `…/#scene=<data>` opens that scene. Nothing leaves the browser; the hash isn't even sent to the server.
// Pure functions plus a small toast, so test/share.test.js runs them in node.

import { normalizeScene } from './presets.js';

export const HASH_KEY = 'scene=';
export const MAX_HASH = 8192; // characters after the '#': long URLs get cut by chat apps and some browsers
const MAX_JSON = 1 << 20; // a link that inflates past 1 MB isn't a scene, so stop reading it

export const TOO_LONG =
  'This scene is too big to share as a link (over 8 KB). Use Save to send the JSON file instead.';

function toBase64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates, but gives up once the output passes `limit` bytes. */
async function inflate(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// Positions picked by dragging carry float noise (1.2300000000000002); 4 decimals is a tenth of a millimetre.
const round = (_key, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);

/** The hash for a scene, without the '#'. */
export async function encodeScene(scene) {
  const json = JSON.stringify(normalizeScene(scene), round);
  return HASH_KEY + toBase64url(await deflate(new TextEncoder().encode(json)));
}

/**
 * The link for a scene: { ok: true, url } or { ok: false, message } when the hash would pass MAX_HASH.
 * `href` is the page's address; any hash on it is replaced.
 */
export async function shareLink(scene, href) {
  const hash = await encodeScene(scene);
  if (hash.length > MAX_HASH) return { ok: false, message: TOO_LONG };
  return { ok: true, url: `${href.split('#')[0]}#${hash}` };
}

/** Whether a location hash ('#scene=…' or 'scene=…') looks like a shared scene. Cheap, so startup can check it. */
export function hasSharedScene(hash) {
  return typeof hash === 'string' && hash.replace(/^#/, '').startsWith(HASH_KEY);
}

/** The scene in a location hash, normalized, or null when there is none or it's damaged. Never throws. */
export async function decodeScene(hash) {
  try {
    if (!hasSharedScene(hash)) return null;
    const data = hash.replace(/^#/, '').slice(HASH_KEY.length);
    if (!data || data.length > MAX_HASH * 2 || !/^[A-Za-z0-9_-]+$/.test(data)) return null;
    const json = new TextDecoder('utf-8', { fatal: true }).decode(await inflate(fromBase64url(data), MAX_JSON));
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeScene(parsed);
  } catch {
    return null;
  }
}

/** A short message at the bottom of the page that fades by itself. Returns the element. */
let toastTimer = 0;
export function showToast(text, { doc = globalThis.document, ms = 3500 } = {}) {
  let el = doc.getElementById('toast');
  if (!el) {
    el = doc.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    doc.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  return el;
}
