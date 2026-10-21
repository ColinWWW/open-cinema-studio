// Render panel: send the playblast + a look still + a prompt to the render server (server/app.py,
// which runs our core-node LTX-2.5 workflow through the Comfy SDK) and show the result next to the
// playblast. The dev server proxies /api/render, /api/look and /api/health to it; a page served from
// elsewhere (GitHub Pages) calls the server at the URL set in the panel (server started with --cors-origin),
// or renders with the visitor's own Comfy API key and no server at all (cloud.js, docs/LIVE_RENDER.md).

import { cloudLook, cloudRender, comfyClient, loadCloud, normalizeBase, saveCloud } from './cloud.js';
import { PROMPT_IDEAS, variantSeeds } from './prompts.js';

const BANNED = ['clay', '3d', 'unreal']; // the model card: describe the finished shot, not the layout

/** Prompt problems worth showing before spending a render. */
export function promptWarnings(prompt) {
  const words = prompt.toLowerCase().split(/[^a-z0-9]+/);
  const out = [];
  if (!prompt.trim()) out.push('Write one or two sentences describing the finished shot.');
  for (const w of BANNED) if (words.includes(w)) out.push(`Avoid "${w}": describe the finished shot, not the layout.`);
  return out;
}

/** Warn when the look still's shape doesn't match the clip (it gets centre-cropped to fit). */
export function aspectWarning(look, output) {
  if (!look) return null;
  const a = look.width / look.height;
  const b = output.width / output.height;
  return Math.abs(a - b) / b > 0.02
    ? `Look still is ${look.width}×${look.height}; it will be centre-cropped to ${output.width}×${output.height}. Frame it like the playblast's frame 0.`
    : null;
}

export function renderForm({ mp4, look, lookName, prompt, output, seed }) {
  const form = new FormData();
  form.append('layout', mp4, 'layout.mp4');
  form.append('look', look, lookName || 'look.png');
  form.append('prompt', prompt);
  form.append('width', String(output.width));
  form.append('height', String(output.height));
  form.append('frames', String(output.frames));
  form.append('seed', String(seed ?? 42));
  return form;
}

/** Form for POST /api/look: frame 0's depth map (near = white) + prompt -> a look still at the clip size. */
export function lookForm({ depth, prompt, output, seed, strength }) {
  const form = new FormData();
  form.append('depth', depth, 'depth.png');
  form.append('prompt', prompt);
  form.append('width', String(output.width));
  form.append('height', String(output.height));
  form.append('seed', String(seed ?? 42));
  if (strength != null) form.append('strength', String(strength));
  return form;
}

const SERVER_KEY = 'ocs.renderServer';
const TARGET_KEY = 'ocs.renderTarget';

/** Where renders run: 'server' (our render server) or 'cloud' (Comfy API with the visitor's key). */
export function loadTarget(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(TARGET_KEY) === 'cloud' ? 'cloud' : 'server';
  } catch {
    return 'server';
  }
}

export function saveTarget(target, storage = globalThis.localStorage) {
  try {
    if (target === 'cloud') storage.setItem(TARGET_KEY, 'cloud');
    else storage.removeItem(TARGET_KEY);
  } catch {
    // blocked storage: the choice lasts for this page view
  }
}

/** Clean up a typed server URL: '' = same origin; adds http:// if missing; drops trailing slashes. Throws if invalid. */
export function normalizeServer(input) {
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Not an http(s) URL: ${input}`);
  if (u.search || u.hash) throw new Error('Leave out ?query and #fragment');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/** URL for an API path ('/api/...', as the server returns them) on the render server ('' = same origin). */
export function apiUrl(server, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${server || ''}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** The saved render server URL ('' when unset or storage is blocked). */
export function loadServer(storage = globalThis.localStorage) {
  try {
    return normalizeServer(storage?.getItem(SERVER_KEY) || '');
  } catch {
    return '';
  }
}

export function saveServer(server, storage = globalThis.localStorage) {
  try {
    if (server) storage.setItem(SERVER_KEY, server);
    else storage.removeItem(SERVER_KEY);
  } catch {
    // private mode / blocked storage: the URL just isn't remembered
  }
}

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/** GET a job's state, retrying a dropped connection or a 5xx (proxy hiccup) a few times; the job keeps running meanwhile. */
async function pollState(url, { fetchFn, wait, pollMs, retries }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchFn(url);
    } catch (err) {
      if (attempt >= retries) throw err;
    }
    if (res && (res.status < 500 || attempt >= retries)) return json(res);
    await wait(pollMs * 2 ** attempt);
  }
}

/**
 * Submit a job ('render' or 'look') and poll until it ends. Resolves with the final state; throws on failure.
 * `signal` (an AbortSignal) cancels: before the submit nothing is sent; after it the job is cancelled on the
 * server too, so a job submitted just after the user pressed Cancel doesn't keep the GPU busy.
 */
export async function runJob(kind, form, { server = '', fetchFn = fetch, onUpdate, pollMs = 1000, retries = 4, sleep, signal } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stop = async (id) => {
    if (id) await cancelJob(kind, id, { server, fetchFn }).catch(() => {});
    throw new Error(`${kind} cancelled`);
  };
  if (signal?.aborted) await stop(null);
  let state = await json(await fetchFn(apiUrl(server, `/api/${kind}`), { method: 'POST', body: form }));
  onUpdate?.(state);
  while (state.status === 'queued' || state.status === 'running') {
    if (signal?.aborted) await stop(state.id);
    await wait(pollMs);
    if (signal?.aborted) await stop(state.id);
    state = await pollState(apiUrl(server, `/api/${kind}/${state.id}`), { fetchFn, wait, pollMs, retries });
    onUpdate?.(state);
  }
  if (state.status !== 'succeeded') throw new Error(state.error || `${kind} ${state.status}`);
  return state;
}

/** POST /api/{render|look}/{id}/cancel. Resolves with the job's state; a job that already ended is fine. */
export async function cancelJob(kind, id, { server = '', fetchFn = fetch } = {}) {
  const res = await fetchFn(apiUrl(server, `/api/${kind}/${id}/cancel`), { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export const runRender = (form, opts) => runJob('render', form, opts);

/** Download a finished job's file (an API path from the server) as a Blob; throws on an error reply. */
export async function fetchBlob(server, path, { fetchFn = fetch } = {}) {
  const res = await fetchFn(apiUrl(server, path));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.blob();
}

/** The seed typed in the panel: any whole number (0 included), else 42. */
export function parseSeed(value) {
  const n = Number(value);
  return String(value ?? '').trim() !== '' && Number.isInteger(n) && n >= 0 ? n : 42;
}

/** POST /api/stitch: cut finished renders (clip 'render') or their layout clips ('layout') together, in order. */
export async function stitchShots(ids, { server = '', clip = 'render', fetchFn = fetch } = {}) {
  const res = await fetchFn(apiUrl(server, '/api/stitch'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ renders: ids, clip }),
  });
  const seq = await json(res);
  if (seq.status !== 'succeeded') throw new Error(seq.error || 'could not join the shots');
  return seq;
}

/** GET /api/health on the render server. Resolves with {ok, target}; throws if nothing (or not our server) answers. */
export async function checkHealth(server, { fetchFn = fetch, timeoutMs = 5000 } = {}) {
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const h = await json(await fetchFn(apiUrl(server, '/api/health'), { signal }));
  if (h.ok !== true) throw new Error('not an Open Cinema Studio render server');
  return h;
}

/** The command that starts a render server this page can call ('proxied': the Vite dev server forwards /api). */
export function serverCommand(pageOrigin, { proxied = false } = {}) {
  return proxied ? 'python -m server.app' : `python -m server.app --cors-origin ${pageOrigin}`;
}

export function describeState(s) {
  const secs = s.created ? Math.round(Date.now() / 1000 - s.created) : 0;
  if (s.status === 'queued') return 'Waiting for the GPU…';
  if (s.stage === 'rendering') {
    const step = s.steps ? `, step ${s.step}/${s.steps}` : '';
    const node = s.node ? ` · ${s.node}${step}` : '';
    return `Rendering ${Math.round((s.progress || 0) * 100)}%${node} (${secs}s)`;
  }
  if (s.status === 'running') return `${s.stage[0].toUpperCase()}${s.stage.slice(1)}… (${secs}s)`;
  if (s.status === 'succeeded') return `Done in ${s.seconds}s`;
  if (s.status === 'cancelled') return 'Cancelled';
  return `Failed: ${s.error}`;
}

// ---------- DOM ----------

/** The target picker and the Comfy key row, built here so index.html keeps the server's markup only. */
function buildCloudControls() {
  const serverRow = document.querySelector('.render-server-row');
  const target = document.createElement('select');
  target.id = 'render-target';
  target.title = 'Where renders run';
  target.append(new Option('Render server', 'server'), new Option('Comfy Cloud (your key)', 'cloud'));
  serverRow.prepend(target);

  const row = document.createElement('div');
  row.id = 'render-cloud-row';
  row.className = 'render-row render-server-row';
  row.innerHTML = `
    <label for="render-cloud-key">Comfy API key</label>
    <input id="render-cloud-key" type="password" autocomplete="off" spellcheck="false" placeholder="comfyui-…" />
    <label for="render-cloud-base">via</label>
    <input id="render-cloud-base" type="text" spellcheck="false" placeholder="your relay, e.g. https://ocs-comfy-relay.you.workers.dev (blank = cloud.comfy.org)" />
    <button id="render-cloud-save">Save &amp; check</button>
    <button id="render-cloud-forget" title="Remove the key from this browser">Forget key</button>`;
  const note = document.createElement('p');
  note.id = 'render-cloud-note';
  note.className = 'hint';
  note.innerHTML = 'Your key is stored only in this browser (localStorage) and sent only to the URL above, never to us. '
    + 'Renders run the same workflows as the render server and bill your Comfy account. '
    + '<a href="https://github.com/ColinWWW/open-cinema-studio/blob/main/docs/LIVE_RENDER.md" target="_blank" rel="noopener">How to set it up</a>';
  serverRow.after(row, note);
  return { serverRow, target, row, note };
}

/**
 * Wire the render panel. `exportPlayblast()` returns {mp4, firstFrame, depth} for the current scene;
 * the panel re-exports only when the scene changed since the last export. The look still comes from
 * a file, or is generated from frame 0's depth map (POST /api/look) so it matches the layout box for box.
 * When no render server answers, the panel shows the bundled plaza example instead (demo mode).
 */
export function initRenderPanel({ getScene, showShot, exportPlayblast, demo, proxied = false }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('render-panel');
  let server = loadServer();
  let target = loadTarget();
  let cloud = loadCloud(); // {key, base}
  const ui = buildCloudControls();
  let demoMode = false;
  let check = 0; // ignores answers from older health checks
  let look = null; // {blob, name, width, height}
  let blast = null; // {mp4, firstFrame, depth, key}
  let rendered = null; // the last render's MP4 blob
  let busy = false;
  let abort = null; // the running work's AbortController: Cancel aborts it, and runJob cancels its job
  const urls = new Map();
  const setUrl = (el, blob) => {
    if (urls.has(el)) URL.revokeObjectURL(urls.get(el));
    const url = blob ? URL.createObjectURL(blob) : '';
    urls.set(el, url);
    el.src = url;
  };

  const sceneKey = () => JSON.stringify(getScene());
  const refreshHints = () => {
    const noPrompt = !$('render-prompt').value.trim();
    $('render-go').disabled = busy || demoMode || !look || noPrompt;
    $('render-generate').disabled = busy || demoMode || noPrompt;
    $('render-variants-go').disabled = busy || demoMode || noPrompt;
    const shots = getScene().shots.length;
    $('render-all').disabled = busy || demoMode || noPrompt || shots < 2 || target === 'cloud';
    $('render-all').textContent = shots < 2 ? 'Render all shots' : `Render all ${shots} shots`;
    $('render-all').title = target === 'cloud' ? 'Needs the render server (it cuts the shots together)'
      : shots < 2 ? 'Add shots (Shots > + Shot) to render a sequence' : $('render-all').dataset.title;
    if (demoMode) {
      $('render-hints').textContent = target === 'cloud'
        ? 'Add your Comfy API key to generate look stills and render your own shot.'
        : 'Connect a render server (or pick Comfy Cloud with your own key) to generate look stills and render your own shot.';
      return;
    }
    const hints = [...promptWarnings($('render-prompt').value)];
    const aspect = aspectWarning(look, getScene().output);
    if (aspect) hints.push(aspect);
    if (look?.key && look.key !== sceneKey()) hints.push('The shot changed since this look still was generated: generate it again so it matches.');
    if (!look) hints.unshift('Add a look still: generate one from the layout, or choose frame 0 restyled with any image model.');
    $('render-hints').textContent = hints.join(' ');
  };

  /** Demo mode swaps the panel's media for the bundled example; leaving it puts the user's own back. */
  function setDemo(on) {
    if (on === demoMode) return;
    demoMode = on;
    $('render-demo').hidden = !on;
    panel.classList.toggle('demo', on);
    if (on) {
      $('render-demo-cmd').textContent = serverCommand(location.origin, { proxied: proxied && !server });
      const media = [['render-frame0', 'frame0'], ['render-depth', 'depth'], ['render-look-img', 'look'],
        ['render-blast', 'layout'], ['render-result', 'render']];
      for (const [id, key] of media) {
        setUrl($(id), null);
        $(id).src = demo[key];
      }
      $('render-download').hidden = true;
      $('render-download-layout').hidden = true;
      $('render-play').click();
    } else {
      setUrl($('render-frame0'), blast?.firstFrame);
      setUrl($('render-depth'), blast?.depth);
      setUrl($('render-blast'), blast?.mp4);
      setUrl($('render-look-img'), look?.blob);
      setUrl($('render-result'), rendered);
      $('render-download').hidden = !rendered;
      $('render-download-layout').hidden = true;
      if (rendered) $('render-download').href = urls.get($('render-result'));
    }
    refreshHints();
  }

  // key: the scene the still was generated from (null for a chosen file)
  const setLook = (blob, name, width, height, key = null) => {
    look = { blob, name, width, height, key };
    if (!demoMode) setUrl($('render-look-img'), blob);
    for (const b of $('render-variants').children) b.classList.toggle('active', b.still?.blob === blob);
    refreshHints();
  };

  /** Every generated still stays in a strip under the look (newest first, up to 8): click one to use it. */
  function addStill(still) {
    const strip = $('render-variants');
    const b = document.createElement('button');
    b.still = still;
    b.title = `Seed ${still.seed}: ${still.prompt}`;
    const img = document.createElement('img');
    img.src = URL.createObjectURL(still.blob);
    const cap = document.createElement('span');
    cap.textContent = still.caption || `seed ${still.seed}`;
    b.append(img, cap);
    b.addEventListener('click', () => setLook(still.blob, still.name, still.width, still.height, still.key));
    strip.prepend(b);
    while (strip.children.length > 8) {
      URL.revokeObjectURL(strip.lastChild.querySelector('img').src);
      strip.lastChild.remove();
    }
    strip.hidden = false;
  }

  /** The playblast of the current scene, exported again only if the scene changed. */
  async function currentBlast(status) {
    if (!blast || blast.key !== sceneKey()) {
      status.textContent = 'Exporting the playblast…';
      const key = sceneKey(); // the scene this export is of, even if it's edited meanwhile
      const r = await exportPlayblast();
      if (!r) throw new Error('a playblast export is already running: try again when it finishes');
      blast = { mp4: r.mp4, firstFrame: r.firstFrame, depth: r.depth, key };
      setUrl($('render-blast'), blast.mp4);
      setUrl($('render-frame0'), blast.firstFrame);
      setUrl($('render-depth'), blast.depth);
    }
    return blast;
  }

  /** Run a job with the panel locked; reports progress in the status line. `work` gets the AbortSignal for runJob. */
  async function withBusy(label, work) {
    if (busy) return;
    busy = true;
    abort = new AbortController();
    const { signal } = abort;
    $('render-cancel').hidden = false;
    refreshHints();
    const status = $('render-status');
    try {
      await work(status, (s) => {
        if (signal.aborted) return; // keep "Cancelling…" up until the job has been cancelled
        status.textContent = `${s.label || label}: ${describeState(s)}`;
        $('render-progress').value = s.status === 'succeeded' ? 1 : s.progress || 0;
      }, signal);
    } catch (err) {
      status.textContent = signal.aborted ? `${label} cancelled.` : `${label} failed: ${err.message}`;
    } finally {
      busy = false;
      abort = null;
      $('render-cancel').hidden = true;
      refreshHints();
    }
  }

  $('render-cancel').addEventListener('click', () => {
    if (!abort) return;
    abort.abort();
    $('render-status').textContent = 'Cancelling…';
  });

  /** Look still from frame 0's depth on the chosen target: {blob, id, seconds}. `signal` cancels it (see runJob). */
  async function makeLook(params, onUpdate, signal) {
    if (target === 'cloud') {
      const { blob, state } = await cloudLook(comfyClient(cloud), params, { onUpdate, signal });
      return { blob, id: state.id.slice(0, 8), seconds: state.seconds };
    }
    const final = await runJob('look', lookForm(params), { server, signal, onUpdate });
    return { blob: await fetchBlob(server, final.image_url), id: final.id, seconds: final.seconds };
  }

  /** Stage-1 render on the chosen target: {blob, id, seconds}. `signal` cancels it (see runJob). */
  async function makeRender(params, onUpdate, signal) {
    if (target === 'cloud') {
      const { blob, state } = await cloudRender(comfyClient(cloud), params, { onUpdate, signal });
      return { blob, id: state.id.slice(0, 8), seconds: state.seconds };
    }
    const final = await runRender(renderForm(params), { server, signal, onUpdate });
    return { blob: await fetchBlob(server, final.video_url), id: final.id, seconds: final.seconds };
  }

  /** Comfy target: a free call (one page of past jobs) proves the key and the route. */
  async function checkCloud() {
    const mine = ++check;
    const el = $('render-server');
    el.classList.remove('bad');
    if (!cloud.key) {
      el.textContent = 'Comfy Cloud: add your API key.';
      el.classList.add('bad');
      setDemo(true);
      return;
    }
    el.textContent = `Checking ${cloud.base}…`;
    try {
      await comfyClient(cloud).check();
      if (mine !== check) return;
      el.textContent = `Comfy API: ${cloud.base} (key works)`;
      setDemo(false);
    } catch (err) {
      if (mine !== check) return;
      el.textContent = `Comfy API: ${err.message}`;
      el.classList.add('bad');
      setDemo(true);
    }
  }

  const checkTarget = () => (target === 'cloud' ? checkCloud() : checkServer());

  function setTarget(t) {
    target = t;
    ui.target.value = t;
    saveTarget(t);
    for (const el of [...ui.serverRow.children].filter((c) => c !== ui.target)) el.hidden = t === 'cloud';
    ui.row.hidden = ui.note.hidden = t !== 'cloud';
    if (!panel.hidden) checkTarget();
    refreshHints();
  }

  async function checkServer() {
    const mine = ++check;
    const el = $('render-server');
    el.textContent = 'Checking the render server…';
    el.classList.remove('bad');
    try {
      const h = await checkHealth(server);
      if (mine !== check) return;
      el.textContent = `Render server: ${h.target}`;
      setDemo(false);
    } catch (err) {
      if (mine !== check) return;
      el.textContent = server ? `${server} not reachable (${err.message}).` : 'No render server on this page’s origin.';
      el.classList.add('bad');
      setDemo(true);
    }
  }

  const connect = () => {
    try {
      server = normalizeServer($('render-server-url').value);
    } catch (err) {
      $('render-server').textContent = err.message;
      $('render-server').classList.add('bad');
      return;
    }
    $('render-server-url').value = server;
    saveServer(server);
    checkServer();
  };

  const saveCloudSettings = () => {
    try {
      cloud = { key: $('render-cloud-key').value.trim(), base: normalizeBase($('render-cloud-base').value) };
    } catch (err) {
      $('render-server').textContent = err.message;
      $('render-server').classList.add('bad');
      return;
    }
    $('render-cloud-base').value = cloud.base;
    saveCloud(cloud);
    checkCloud();
  };
  $('render-cloud-key').value = cloud.key;
  $('render-cloud-base').value = cloud.base;
  $('render-cloud-save').addEventListener('click', saveCloudSettings);
  $('render-cloud-key').addEventListener('change', saveCloudSettings);
  $('render-cloud-base').addEventListener('change', saveCloudSettings);
  $('render-cloud-forget').addEventListener('click', () => {
    $('render-cloud-key').value = '';
    saveCloudSettings();
  });
  ui.target.addEventListener('change', () => setTarget(ui.target.value));
  setTarget(target);

  $('render-all').dataset.title = $('render-all').title;
  $('render-server-url').value = server;
  $('render-server-url').addEventListener('change', connect);
  $('render-connect').addEventListener('click', connect);

  $('render-open').addEventListener('click', () => {
    panel.hidden = false;
    checkTarget();
    refreshHints();
  });
  $('render-close').addEventListener('click', () => (panel.hidden = true));
  $('render-prompt').addEventListener('input', refreshHints);

  $('render-look').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    setLook(file, file.name, bmp.width, bmp.height);
    bmp.close();
  });

  /** Generate one look still per seed from frame 0's depth; the first becomes the look, all go in the strip. */
  const generateLooks = (seeds) =>
    withBusy('Look still', async (status, onUpdate, signal) => {
      const { depth } = await currentBlast(status);
      const scene = getScene();
      const prompt = $('render-prompt').value;
      for (const [i, seed] of seeds.entries()) {
        const label = seeds.length > 1 ? `Look still ${i + 1}/${seeds.length}` : 'Look still';
        const final = await makeLook({ depth, prompt, output: scene.output, seed }, (s) => onUpdate({ ...s, label }), signal);
        const blob = final.blob;
        const still = { blob, name: `look_${final.id}.png`, width: scene.output.width, height: scene.output.height, key: blast.key, seed, prompt };
        addStill(still);
        if (i === 0) setLook(still.blob, still.name, still.width, still.height, still.key);
        status.textContent = `${label} ready in ${final.seconds}s.`;
      }
      status.textContent += seeds.length > 1
        ? ' Click the still you like in the strip, then render the shot.'
        : ' Happy with it? Render the shot, or generate again with another seed.';
    });
  const seed = () => parseSeed($('render-seed').value);

  $('render-generate').addEventListener('click', () => generateLooks([seed()]));
  let variantsAfter = null; // the next "3 variants" carries on from the last seed it used
  $('render-seed').addEventListener('input', () => (variantsAfter = null));
  $('render-variants-go').addEventListener('click', () => {
    const seeds = variantSeeds((variantsAfter ?? seed()) + 1, 3);
    variantsAfter = seeds[2];
    generateLooks(seeds);
  });

  for (const { group, prompts } of PROMPT_IDEAS) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const p of prompts) og.append(new Option(p.length > 44 ? `${p.slice(0, 42)}…` : p, p));
    $('render-ideas').append(og);
  }
  $('render-ideas').addEventListener('change', (e) => {
    if (!e.target.value) return;
    $('render-prompt').value = e.target.value;
    e.target.value = '';
    refreshHints();
  });

  /** Show a finished clip in the result player with a download link. */
  function showResult(blob, filename, link = 'render-download', el = 'render-result', text = 'Download render') {
    setUrl($(el), blob);
    const a = $(link);
    a.textContent = text;
    a.href = urls.get($(el));
    a.download = filename;
    a.hidden = false;
  }

  $('render-all').addEventListener('click', () =>
    withBusy('Sequence', async (status, onUpdate, signal) => {
      for (const id of ['render-download', 'render-download-layout']) $(id).hidden = true;
      const prompt = $('render-prompt').value;
      const n = getScene().shots.length;
      const ids = [];
      for (let i = 0; i < n; i++) {
        const stem = showShot(i);
        const label = `Shot ${i + 1}/${n}`;
        const { depth, mp4 } = await currentBlast(status);
        const scene = getScene();
        const lookJob = await runJob('look', lookForm({ depth, prompt, output: scene.output, seed: seed() }), {
          server, signal, onUpdate: (s) => onUpdate({ ...s, label: `${label} look still` }),
        });
        const still = await fetchBlob(server, lookJob.image_url);
        addStill({ blob: still, name: `${stem}_look.png`, width: scene.output.width, height: scene.output.height, key: blast.key, seed: seed(), prompt, caption: `shot ${i + 1}` });
        setLook(still, `${stem}_look.png`, scene.output.width, scene.output.height, blast.key);
        const form = renderForm({ mp4, look: still, lookName: `${stem}_look.png`, prompt, output: scene.output, seed: seed() });
        const final = await runRender(form, { server, signal, onUpdate: (s) => onUpdate({ ...s, label: `${label} render` }) });
        ids.push(final.id);
      }
      status.textContent = 'Cutting the shots together…';
      const [seq, layout] = await Promise.all([stitchShots(ids, { server }), stitchShots(ids, { server, clip: 'layout' })]);
      const name = (getScene().name || 'scene').replace(/[^\w.-]+/g, '_');
      rendered = await fetchBlob(server, seq.video_url);
      showResult(rendered, `${name}_sequence_${seq.id}.mp4`, 'render-download', 'render-result', 'Download sequence');
      showResult(await fetchBlob(server, layout.video_url), `${name}_layout_sequence_${layout.id}.mp4`,
        'render-download-layout', 'render-blast', 'Download layout sequence');
      blast = null; // the playblast player now shows the layout sequence
      status.textContent = `Sequence done: ${n} shots, ${seq.frames} frames (${(seq.frames / 24).toFixed(1)} s).`;
      $('render-play').click();
    }),
  );

  $('render-play').addEventListener('click', () => {
    for (const v of [$('render-blast'), $('render-result')]) {
      v.currentTime = 0;
      v.play().catch(() => {});
    }
  });

  $('render-go').addEventListener('click', () =>
    withBusy('Render', async (status, onUpdate, signal) => {
      for (const id of ['render-download', 'render-download-layout']) $(id).hidden = true;
      const { mp4 } = await currentBlast(status);
      const scene = getScene();
      const final = await makeRender({
        mp4, look: look.blob, lookName: look.name, prompt: $('render-prompt').value,
        output: scene.output, seed: seed(),
      }, onUpdate, signal);
      rendered = final.blob;
      showResult(rendered, `${(scene.name || 'shot').replace(/[^\w.-]+/g, '_')}_render_${final.id}.mp4`);
      $('render-play').click();
    }),
  );
}
