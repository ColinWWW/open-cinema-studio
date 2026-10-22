// The model providers the scene agent can use. Each is a createMessage (runner.js) for one API; the panel and
// scripts/design-scene.mjs pick one by id. Keys are the visitor's own and go straight to the provider's API
// (or the relay URL they set), never to this project's servers.

import { CLAUDE_MODEL, claudeProvider } from './claude.js';
import { GEMINI_MODEL, geminiProvider } from './gemini.js';
import { OPENAI_MODEL, openaiProvider } from './openai.js';

export const PROVIDERS = {
  claude: {
    label: 'Claude',
    keyLabel: 'Claude API key',
    keyHint: 'sk-ant-…',
    api: 'api.anthropic.com',
    env: 'ANTHROPIC_API_KEY',
    model: CLAUDE_MODEL,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    revoke: 'https://console.anthropic.com',
    create: claudeProvider,
  },
  gemini: {
    label: 'Gemini',
    keyLabel: 'Gemini API key',
    keyHint: 'AIza…',
    api: 'generativelanguage.googleapis.com',
    env: 'GEMINI_API_KEY',
    model: GEMINI_MODEL,
    models: ['gemini-pro-latest', 'gemini-flash-latest', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'],
    revoke: 'https://aistudio.google.com/apikey',
    create: geminiProvider,
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    keyLabel: 'OpenAI API key',
    keyHint: 'sk-…',
    api: 'api.openai.com',
    env: 'OPENAI_API_KEY',
    model: OPENAI_MODEL,
    models: ['gpt-5.5', 'gpt-6.1-sol', 'gpt-5.4-mini'],
    revoke: 'https://platform.openai.com/api-keys',
    create: openaiProvider,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** A createMessage for provider `id` ('claude' | 'gemini' | 'openai'). */
export function createProvider(id, { apiKey, baseURL, model } = {}) {
  const p = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (!p) throw new Error(`Unknown provider ${JSON.stringify(id)}: use ${PROVIDER_IDS.join(', ')}.`);
  return p.create({ apiKey, baseURL: baseURL || undefined, model: model || p.model });
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Clean up a typed API URL for provider `id` ('' = the provider's own API). The key goes there, so only https
 * (or http on this machine). Returns what that provider's SDK takes as its base URL.
 */
export function normalizeBase(input, id = 'claude') {
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) {
    throw new Error('Use an https:// URL (http only for localhost): your key is sent there.');
  }
  if (!LOCAL.has(u.hostname) && !u.hostname.includes('.')) {
    throw new Error('That isn’t a web address (did the key go in the “via” field?). Use the full URL, or leave it blank.');
  }
  if (u.search || u.hash || u.username || u.password) throw new Error('Leave out ?query, #fragment and user:password@');
  const base = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  if (id === 'openai') return /\/v1$/.test(base) ? base : `${base}/v1`; // the OpenAI SDK's base URL includes /v1
  if (id === 'gemini') return base.replace(/\/v1(beta|alpha)?$/, ''); // the Gemini SDK adds the API version
  return base.replace(/\/v1$/, ''); // the Anthropic SDK adds /v1
}
