// The scene agent panel, floating over the viewport: describe a shot, and an agent blocks it out in the
// editor (runner.js + tools.js) and drafts the render prompt. Two ways to run it: "Use your chat app" (no key:
// copy a prompt into Claude.ai, ChatGPT or Gemini and paste the reply back, chat.js), or an API key for Claude,
// Gemini or ChatGPT (providers/, picked from the key's shape), kept in this browser like the Comfy key
// (cloud.js). Each run is one undo step.

import { chatPrompt, parseChatReply, replayChatCalls } from './chat.js';
import { PROVIDERS, PROVIDER_IDS, createProvider, detectProvider, normalizeBase } from './providers/index.js';
import { runSceneAgent } from './runner.js';

const PROVIDER_KEY = 'ocs.agentProvider';
const MODE_KEY = 'ocs.agentMode';
const MODES = ['chat', 'key'];
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

/** 'chat' or 'key': the mode picked last, else 'key' when a key is saved and 'chat' when not. */
export function loadMode({ hasKey = false } = {}, storage = globalThis.localStorage) {
  try {
    const m = storage?.getItem(MODE_KEY);
    if (MODES.includes(m)) return m;
  } catch {
    // blocked storage: fall through to the default
  }
  return hasKey ? 'key' : 'chat';
}

export function saveMode(mode, storage = globalThis.localStorage) {
  try {
    storage.setItem(MODE_KEY, mode);
  } catch {
    // blocked storage: the mode is only kept for this page view
  }
}

/** One line for the log, e.g. "Added kiosk, crate, woman". Never throws, whatever the model sent. */
export function describeStep(step) {
  try {
    return stepLine(step);
  } catch {
    return step?.error ? `${step.name} — ${step.skipped ? 'skipped' : 'retrying'}: ${step.error}` : String(step?.name);
  }
}

function stepLine({ name, input: raw, result, error, skipped }) {
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
  return error ? `${line} — ${skipped ? 'skipped' : 'retrying'}: ${error}` : line;
}

/** Copy `text`; false when the browser won't (no clipboard permission and no execCommand). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/**
 * Wire the panel. `editor`: {getScene, applyScene(scene, group), viewShot(scene, shot, frame), usePrompt(text)}.
 * Returns {run(brief, {createMessage}), copyPrompt(brief), buildFromReply(reply), open(), close()}; run is
 * also what window.ocs.agent.run calls.
 */
export function initAgentPanel(editor) {
  const $ = (id) => document.getElementById(id);
  const panel = $('agent-panel');
  const pill = $('agent-open');
  let settings = loadAgentSettings();
  let mode = loadMode({ hasKey: !!settings.key });
  let controller = null;
  let runs = 0;
  let lastPrompt = null;
  let lastBrief = '';

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
  /** Point the Advanced fields at provider `id` (its saved model and URL); the key box is left alone. */
  const fillAdvanced = (id) => {
    const p = PROVIDERS[id];
    const saved = loadAgentSettings(id);
    $('agent-provider').value = id;
    $('agent-model').placeholder = p.model;
    $('agent-model').value = saved.model;
    $('agent-models').replaceChildren(...p.models.map((m) => new Option(m)));
    $('agent-base').placeholder = `blank = ${p.api}, or your relay's URL`;
    $('agent-base').value = saved.base;
  };
  const showKind = () => {
    const key = $('agent-key').value.trim();
    const id = $('agent-provider').value;
    $('agent-key-kind').textContent = !key ? '' : detectProvider(key) ? `${PROVIDERS[id].label} key (${$('agent-model').value.trim() || PROVIDERS[id].model}).` : `Not a key shape we know: it goes to ${PROVIDERS[id].label} (change it under Advanced).`;
  };
  const showSettings = (on) => {
    $('agent-settings').hidden = !on;
    $('agent-settings-btn').setAttribute('aria-expanded', String(on));
    if (on) {
      fillAdvanced(settings.provider);
      $('agent-key').value = settings.key;
      showKind();
    }
  };
  const idleStatus = () =>
    mode === 'chat'
      ? setStatus('Describe the shot, then copy the prompt into your chat app.')
      : settings.key
        ? setStatus(`${label()} (${modelName()}).`)
        : setStatus('Paste an API key to start.');
  const setMode = (m) => {
    mode = m;
    $('agent-mode-chat').setAttribute('aria-pressed', String(m === 'chat'));
    $('agent-mode-key').setAttribute('aria-pressed', String(m === 'key'));
    $('agent-go').textContent = m === 'chat' ? 'Copy prompt' : 'Build';
    $('agent-settings-btn').hidden = m !== 'key' || !settings.key;
    if (m === 'chat') {
      showSettings(false);
    } else {
      $('agent-chat').hidden = true;
      showSettings(!settings.key);
    }
    idleStatus();
  };
  const busy = (on) => {
    for (const id of ['agent-go', 'agent-build-reply']) $(id).disabled = on;
    $('agent-go').hidden = on;
    $('agent-stop').hidden = !on;
    $('agent-brief').disabled = on;
  };
  const startLog = (brief) => {
    $('agent-result').hidden = true;
    $('agent-log').replaceChildren();
    log(`“${brief}”`, 'brief');
  };
  const showResult = ({ summary, prompt }) => {
    lastPrompt = prompt;
    $('agent-summary').textContent = summary || 'The scene is built.';
    $('agent-prompt').textContent = prompt || '';
    $('agent-prompt').hidden = !prompt;
    $('agent-use-prompt').hidden = !prompt;
    $('agent-result').hidden = false;
  };

  function show() {
    panel.hidden = false;
    pill.hidden = true;
    pill.setAttribute('aria-expanded', 'true');
  }
  function open() {
    show();
    setMode(mode);
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
    if (typeof brief !== 'string' || !brief.trim()) {
      setStatus('Describe the scene first.', true);
      return null;
    }
    if (!createMessage && !settings.key) {
      showSettings(true);
      setStatus('Paste an API key first, or use your chat app.', true);
      return null;
    }
    show();
    const group = `agent:${++runs}`;
    controller = new AbortController();
    busy(true);
    startLog(brief.trim());
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
      setStatus('Done. Ctrl+Z undoes the build.');
      showResult(out);
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

  /** Chat-app mode, step 1: copy the prompt for `brief` and open the reply box. Resolves the prompt. */
  async function copyPrompt(brief) {
    let text;
    try {
      text = chatPrompt(brief, editor.getScene());
    } catch (err) {
      setStatus(err.message, true);
      return null;
    }
    lastBrief = brief.trim();
    $('agent-chat-prompt').value = text;
    $('agent-chat').hidden = false;
    const copied = await copyText(text);
    setStatus(copied ? 'Prompt copied. Paste it into your chat app, then paste its reply below.' : 'Couldn’t copy: open “Show the prompt” and copy it from there.', !copied);
    $('agent-reply').focus();
    return text;
  }

  /** Chat-app mode, step 2: build the scene from the pasted reply. Resolves {scene, prompt, summary, errors}. */
  async function buildFromReply(reply) {
    if (controller) return null;
    if (typeof reply !== 'string' || !reply.trim()) {
      setStatus('Paste the reply from your chat app first.', true);
      return null;
    }
    let plan;
    try {
      plan = parseChatReply(reply);
    } catch (err) {
      setStatus(err.message, true);
      return null;
    }
    const group = `agent:${++runs}`;
    controller = new AbortController();
    busy(true);
    startLog(lastBrief || 'From your chat app');
    try {
      const out = await replayChatCalls({
        scene: editor.getScene(),
        calls: plan.calls,
        onScene: (scene) => editor.applyScene(scene, group),
        onStep: (step) => log(describeStep(step), step.error ? 'err' : ''),
      });
      setStatus(out.errors ? `Built, skipping ${out.errors} step(s) the chat got wrong. Ctrl+Z undoes the build.` : 'Done. Ctrl+Z undoes the build.');
      showResult({ summary: plan.summary, prompt: out.prompt });
      $('agent-reply').value = '';
      $('agent-chat').hidden = true;
      return { ...out, summary: plan.summary };
    } catch (err) {
      setStatus(err?.message || String(err), true);
      return null;
    } finally {
      controller = null;
      busy(false);
    }
  }

  const go = () => (mode === 'chat' ? copyPrompt($('agent-brief').value) : run($('agent-brief').value));

  pill.addEventListener('click', open);
  $('agent-close').addEventListener('click', close);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  for (const m of MODES) {
    $(`agent-mode-${m}`).addEventListener('click', () => {
      saveMode(m);
      setMode(m);
      $('agent-brief').focus();
    });
  }
  $('agent-settings-btn').addEventListener('click', () => showSettings($('agent-settings').hidden));
  $('agent-key').addEventListener('input', () => {
    const id = detectProvider($('agent-key').value);
    if (id && id !== $('agent-provider').value) fillAdvanced(id);
    showKind();
  });
  $('agent-provider').addEventListener('change', (e) => {
    fillAdvanced(e.target.value);
    $('agent-key').value = loadAgentSettings(e.target.value).key; // each provider keeps its own key
    showKind();
  });
  $('agent-model').addEventListener('input', showKind);
  $('agent-save').addEventListener('click', () => {
    const provider = $('agent-provider').value;
    try {
      settings = { provider, key: $('agent-key').value.trim(), base: normalizeBase($('agent-base').value, provider), model: $('agent-model').value.trim() };
    } catch (err) {
      $('agent-advanced').open = true;
      setStatus(err.message, true);
      return;
    }
    if (!settings.key) {
      setStatus('Paste an API key first.', true);
      return;
    }
    saveAgentSettings(settings);
    showSettings(false);
    $('agent-settings-btn').hidden = false;
    setStatus(`${label()} (${modelName()}): key saved in this browser.`);
    $('agent-brief').focus();
  });
  $('agent-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('agent-save').click();
  });
  $('agent-forget').addEventListener('click', () => {
    const provider = $('agent-provider').value;
    saveAgentSettings({ ...loadAgentSettings(provider), key: '' }, undefined, { activate: false });
    if (provider === settings.provider) settings = { ...settings, key: '' };
    $('agent-key').value = '';
    $('agent-settings-btn').hidden = !settings.key;
    showKind();
    setStatus(`${PROVIDERS[provider].keyLabel} removed from this browser.`);
  });
  $('agent-go').addEventListener('click', go);
  $('agent-stop').addEventListener('click', () => controller?.abort());
  $('agent-brief').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      go();
    }
  });
  $('agent-build-reply').addEventListener('click', () => buildFromReply($('agent-reply').value));
  // Pasting the reply is the last step, so it builds right away; a reply that won't parse just says why.
  $('agent-reply').addEventListener('paste', () => setTimeout(() => buildFromReply($('agent-reply').value)));
  $('agent-use-prompt').addEventListener('click', () => lastPrompt && editor.usePrompt(lastPrompt));

  return { run, copyPrompt, buildFromReply, open, close };
}
