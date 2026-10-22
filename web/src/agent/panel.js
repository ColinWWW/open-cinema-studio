// The scene agent panel, floating over the viewport: describe a shot, and an agent blocks it out in the
// editor (runner.js + tools.js) and drafts the render prompt. The model is Claude, Gemini or ChatGPT
// (providers/), with the visitor's own key, kept in this browser like the Comfy key (cloud.js). Each run is
// one undo step.

import { PROVIDERS, PROVIDER_IDS, createProvider, normalizeBase } from './providers/index.js';
import { runSceneAgent } from './runner.js';

const PROVIDER_KEY = 'ocs.agentProvider';
const stored = (id, what) => `ocs.${id}${what}`; // ocs.claudeKey, ocs.geminiBase, ocs.openaiModel, …

/** The provider picked last ('claude' when none or storage is blocked). */
export function loadProvider(storage = globalThis.localStorage) {
  try {
    const id = storage?.getItem(PROVIDER_KEY);
    return PROVIDER_IDS.includes(id) ? id : 'claude';
  } catch {
    return 'claude';
  }
}

/** {provider, key, base, model} saved in this browser for `provider`; '' for what's unset. */
export function loadAgentSettings(provider = loadProvider(), storage = globalThis.localStorage) {
  const empty = { provider, key: '', base: '', model: '' };
  try {
    return {
      provider,
      key: storage?.getItem(stored(provider, 'Key')) || '',
      base: normalizeBase(storage?.getItem(stored(provider, 'Base')) || '', provider),
      model: storage?.getItem(stored(provider, 'Model')) || '',
    };
  } catch {
    return empty;
  }
}

/** Save one provider's settings and (unless `activate` is false) make it the one the panel uses. */
export function saveAgentSettings({ provider, key, base, model }, storage = globalThis.localStorage, { activate = true } = {}) {
  const put = (name, value) => (value ? storage.setItem(name, value) : storage.removeItem(name));
  try {
    put(stored(provider, 'Key'), key);
    put(stored(provider, 'Base'), base);
    put(stored(provider, 'Model'), model);
    if (activate) put(PROVIDER_KEY, provider === 'claude' ? '' : provider);
  } catch {
    // private mode / blocked storage: the key is only kept for this page view
  }
}

/** One line for the log, e.g. "Added 3 objects: kiosk, crate, woman". */
export function describeStep({ name, input: raw, result, error }) {
  const input = raw && typeof raw === 'object' ? raw : {}; // a malformed call can come with no input at all
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

  for (const id of PROVIDER_IDS) $('agent-provider').add(new Option(PROVIDERS[id].label, id));
  const label = () => PROVIDERS[settings.provider].label;
  const modelName = () => settings.model || PROVIDERS[settings.provider].model;

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
  /** Fill the settings fields with what's saved for provider `id`. */
  const fillSettings = (id) => {
    const p = PROVIDERS[id];
    const saved = loadAgentSettings(id);
    $('agent-provider').value = id;
    $('agent-key-label').textContent = p.keyLabel;
    $('agent-key').placeholder = p.keyHint;
    $('agent-key').value = saved.key;
    $('agent-model').placeholder = p.model;
    $('agent-model').value = saved.model;
    $('agent-models').replaceChildren(...p.models.map((m) => new Option(m)));
    $('agent-base').placeholder = `blank = ${p.api}, or your relay's URL`;
    $('agent-base').value = saved.base;
  };
  const showSettings = (on) => {
    $('agent-settings').hidden = !on;
    $('agent-settings-btn').setAttribute('aria-expanded', String(on));
    if (on) fillSettings(settings.provider);
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
      setStatus(`Add your ${PROVIDERS[settings.provider].keyLabel} to start, or pick another model provider.`);
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
      setStatus(`Add your ${PROVIDERS[settings.provider].keyLabel} first.`, true);
      return null;
    }
    show();
    const group = `agent:${++runs}`;
    controller = new AbortController();
    busy(true);
    $('agent-result').hidden = true;
    $('agent-log').replaceChildren();
    log(`“${brief.trim()}”`, 'brief');
    setStatus(createMessage ? 'Blocking out the scene…' : `Blocking out the scene with ${label()} (${modelName()})…`);
    try {
      const out = await runSceneAgent({
        brief,
        scene: editor.getScene(),
        createMessage: createMessage || createProvider(settings.provider, { apiKey: settings.key, baseURL: settings.base, model: settings.model }),
        host: { viewShot: editor.viewShot, getScene: editor.getScene },
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
  $('agent-provider').addEventListener('change', (e) => fillSettings(e.target.value));
  $('agent-save').addEventListener('click', () => {
    const provider = $('agent-provider').value;
    try {
      settings = { provider, key: $('agent-key').value.trim(), base: normalizeBase($('agent-base').value, provider), model: $('agent-model').value.trim() };
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    saveAgentSettings(settings);
    showSettings(false);
    setStatus(settings.key ? `${label()} (${modelName()}): key saved in this browser.` : `No ${PROVIDERS[provider].keyLabel} set.`, !settings.key);
    $('agent-brief').focus();
  });
  $('agent-forget').addEventListener('click', () => {
    const provider = $('agent-provider').value;
    saveAgentSettings({ ...loadAgentSettings(provider), key: '' }, undefined, { activate: false });
    if (provider === settings.provider) settings = { ...settings, key: '' };
    $('agent-key').value = '';
    setStatus(`${PROVIDERS[provider].keyLabel} removed from this browser.`);
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
