// The scene agent panel, floating over the viewport: describe a shot, and an agent blocks it out in the
// editor (runner.js + tools.js) and drafts the render prompt. The Claude API key is the visitor's own,
// kept in this browser like the Comfy key (cloud.js). Each run is one undo step.

import { DEFAULT_MODEL, claudeProvider, runSceneAgent } from './runner.js';

const KEY_KEY = 'ocs.claudeKey';
const BASE_KEY = 'ocs.claudeBase';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Clean up a typed API URL ('' = the Claude API). The key goes there, so only https (or http on this machine). */
export function normalizeAgentBase(input) {
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
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** {key, base} saved in this browser; '' when unset or storage is blocked. */
export function loadAgentSettings(storage = globalThis.localStorage) {
  try {
    return { key: storage?.getItem(KEY_KEY) || '', base: normalizeAgentBase(storage?.getItem(BASE_KEY) || '') };
  } catch {
    return { key: '', base: '' };
  }
}

export function saveAgentSettings({ key, base }, storage = globalThis.localStorage) {
  try {
    if (key) storage.setItem(KEY_KEY, key);
    else storage.removeItem(KEY_KEY);
    if (base) storage.setItem(BASE_KEY, base);
    else storage.removeItem(BASE_KEY);
  } catch {
    // private mode / blocked storage: the key is only kept for this page view
  }
}

/** One line for the log, e.g. "Added 3 objects: kiosk, crate, woman". */
export function describeStep({ name, input = {}, result, error }) {
  const what = {
    get_scene: () => 'Read the scene',
    new_scene: () => `New scene “${input.name}”`,
    add_objects: () => `Added ${(input.objects || []).map((o) => o.name || o.type).join(', ')}`,
    update_object: () => `Changed ${input.name || 'an object'}`,
    remove_objects: () => `Removed ${(input.ids || []).length} object(s)`,
    animate_object: () => (result?.moving ? 'Set a move for an object' : 'Made an object stand still'),
    set_camera: () => `Framed shot ${(input.shot ?? result?.shot ?? 0) + 1}${input.name ? ` (${input.name})` : ''}`,
    camera_move: () => `Camera move: ${String(input.move).replace(/_/g, ' ')}`,
    add_shot: () => `Added shot “${input.name}”`,
    remove_shot: () => `Removed shot ${(input.shot ?? 0) + 1}`,
    view_shot: () => `Looked through shot ${(input.shot ?? result?.shot ?? 0) + 1} at frame ${input.frame ?? 0}`,
    suggest_prompt: () => 'Wrote the render prompt',
  }[name];
  const line = what ? what() : name;
  return error ? `${line} — retrying: ${error}` : line;
}

/**
 * Wire the panel. `editor`: {getScene, applyScene(scene, group), viewShot(scene, shot, frame), usePrompt(text)}.
 * Returns {run(brief, {createMessage}), open(), close()}; run is also what window.ocs.agent.run calls.
 */
export function initAgentPanel(editor) {
  const $ = (id) => document.getElementById(id);
  const panel = $('agent-panel');
  const pill = $('agent-open');
  let settings = loadAgentSettings();
  let controller = null;
  let runs = 0;
  let lastPrompt = null;

  const setStatus = (msg, bad = false) => {
    $('agent-status').textContent = msg;
    $('agent-status').classList.toggle('bad', bad);
  };
  const log = (msg, cls = '') => {
    const li = document.createElement('li');
    li.textContent = msg;
    if (cls) li.className = cls;
    $('agent-log').append(li);
    $('agent-log').scrollTop = $('agent-log').scrollHeight;
  };
  const showSettings = (on) => {
    $('agent-settings').hidden = !on;
    $('agent-settings-btn').setAttribute('aria-expanded', String(on));
    if (on) {
      $('agent-key').value = settings.key;
      $('agent-base').value = settings.base;
    }
  };
  const busy = (on) => {
    $('agent-go').hidden = on;
    $('agent-stop').hidden = !on;
    $('agent-brief').disabled = on;
  };

  function show() {
    panel.hidden = false;
    pill.hidden = true;
    pill.setAttribute('aria-expanded', 'true');
  }
  function open() {
    show();
    if (!settings.key) {
      showSettings(true);
      setStatus('Add your Claude API key to start.');
    }
    $('agent-brief').focus();
  }
  function close() {
    controller?.abort();
    panel.hidden = true;
    pill.hidden = false;
    pill.setAttribute('aria-expanded', 'false');
    pill.focus();
  }

  async function run(brief, { createMessage } = {}) {
    if (controller) return null;
    if (!createMessage && !settings.key) {
      showSettings(true);
      setStatus('Add your Claude API key first.', true);
      return null;
    }
    show();
    const group = `agent:${++runs}`;
    controller = new AbortController();
    busy(true);
    $('agent-result').hidden = true;
    $('agent-log').replaceChildren();
    log(`“${brief.trim()}”`, 'brief');
    setStatus('Blocking out the scene…');
    try {
      const out = await runSceneAgent({
        brief,
        scene: editor.getScene(),
        createMessage: createMessage || claudeProvider({ apiKey: settings.key, baseURL: settings.base || undefined, model: DEFAULT_MODEL }),
        host: { viewShot: editor.viewShot },
        signal: controller.signal,
        onScene: (scene) => editor.applyScene(scene, group),
        onStep: (step) => log(describeStep(step), step.error ? 'err' : ''),
      });
      setStatus('Done. Ctrl+Z undoes the whole build.');
      lastPrompt = out.prompt;
      $('agent-summary').textContent = out.summary || 'The scene is built.';
      $('agent-prompt').textContent = out.prompt || '';
      $('agent-prompt').hidden = !out.prompt;
      $('agent-use-prompt').hidden = !out.prompt;
      $('agent-result').hidden = false;
      return out;
    } catch (err) {
      const stopped = controller.signal.aborted;
      setStatus(stopped ? 'Stopped. What it built so far stays (Ctrl+Z undoes it).' : err?.message || String(err), !stopped);
      return null;
    } finally {
      controller = null;
      busy(false);
    }
  }

  pill.addEventListener('click', open);
  $('agent-close').addEventListener('click', close);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  $('agent-settings-btn').addEventListener('click', () => showSettings($('agent-settings').hidden));
  $('agent-save').addEventListener('click', () => {
    try {
      settings = { key: $('agent-key').value.trim(), base: normalizeAgentBase($('agent-base').value) };
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    saveAgentSettings(settings);
    showSettings(false);
    setStatus(settings.key ? 'Key saved in this browser.' : 'No key set.', !settings.key);
    $('agent-brief').focus();
  });
  $('agent-forget').addEventListener('click', () => {
    settings = { key: '', base: '' };
    saveAgentSettings(settings);
    $('agent-key').value = $('agent-base').value = '';
    setStatus('Key removed from this browser.');
  });
  $('agent-go').addEventListener('click', () => run($('agent-brief').value));
  $('agent-stop').addEventListener('click', () => controller?.abort());
  $('agent-brief').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run($('agent-brief').value);
    }
  });
  $('agent-use-prompt').addEventListener('click', () => lastPrompt && editor.usePrompt(lastPrompt));

  return { run, open, close };
}
