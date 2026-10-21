// Render panel: send the playblast + a look still + a prompt to the render server (server/app.py,
// which runs our core-node LTX-2.5 workflow through the Comfy SDK) and show the result next to the
// playblast. The dev server proxies /api/render, /api/look and /api/health to it; a page served from
// elsewhere (GitHub Pages) calls the server at the URL set in the panel (server started with --cors-origin).

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

/** Submit a job ('render' or 'look') and poll until it ends. Resolves with the final state; throws on failure. */
export async function runJob(kind, form, { server = '', fetchFn = fetch, onUpdate, pollMs = 1000, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let state = await json(await fetchFn(apiUrl(server, `/api/${kind}`), { method: 'POST', body: form }));
  onUpdate?.(state);
  while (state.status === 'queued' || state.status === 'running') {
    await wait(pollMs);
    state = await json(await fetchFn(apiUrl(server, `/api/${kind}/${state.id}`)));
    onUpdate?.(state);
  }
  if (state.status !== 'succeeded') throw new Error(state.error || `${kind} ${state.status}`);
  return state;
}

export const runRender = (form, opts) => runJob('render', form, opts);

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
  if (s.stage === 'rendering') return `Rendering ${Math.round((s.progress || 0) * 100)}% (${secs}s)`;
  if (s.status === 'running') return `${s.stage[0].toUpperCase()}${s.stage.slice(1)}… (${secs}s)`;
  if (s.status === 'succeeded') return `Done in ${s.seconds}s`;
  return `Failed: ${s.error}`;
}

// ---------- DOM ----------

/**
 * Wire the render panel. `exportPlayblast()` returns {mp4, firstFrame, depth} for the current scene;
 * the panel re-exports only when the scene changed since the last export. The look still comes from
 * a file, or is generated from frame 0's depth map (POST /api/look) so it matches the layout box for box.
 * When no render server answers, the panel shows the bundled plaza example instead (demo mode).
 */
export function initRenderPanel({ getScene, exportPlayblast, demo, proxied = false }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('render-panel');
  let server = loadServer();
  let demoMode = false;
  let check = 0; // ignores answers from older health checks
  let look = null; // {blob, name, width, height}
  let blast = null; // {mp4, firstFrame, depth, key}
  let rendered = null; // the last render's MP4 blob
  let busy = false;
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
    if (demoMode) {
      $('render-hints').textContent = 'Connect a render server to generate look stills and render your own shot.';
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
      $('render-play').click();
    } else {
      setUrl($('render-frame0'), blast?.firstFrame);
      setUrl($('render-depth'), blast?.depth);
      setUrl($('render-blast'), blast?.mp4);
      setUrl($('render-look-img'), look?.blob);
      setUrl($('render-result'), rendered);
      $('render-download').hidden = !rendered;
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
    cap.textContent = `seed ${still.seed}`;
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
      const r = await exportPlayblast();
      blast = { mp4: r.mp4, firstFrame: r.firstFrame, depth: r.depth, key: sceneKey() };
      setUrl($('render-blast'), blast.mp4);
      setUrl($('render-frame0'), blast.firstFrame);
      setUrl($('render-depth'), blast.depth);
    }
    return blast;
  }

  /** Run a job with the panel locked; reports progress in the status line. */
  async function withBusy(label, work) {
    if (busy) return;
    busy = true;
    refreshHints();
    const status = $('render-status');
    try {
      await work(status, (s) => {
        status.textContent = `${s.label || label}: ${describeState(s)}`;
        $('render-progress').value = s.status === 'succeeded' ? 1 : s.progress || 0;
      });
    } catch (err) {
      status.textContent = `${label} failed: ${err.message}`;
    } finally {
      busy = false;
      refreshHints();
    }
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

  $('render-server-url').value = server;
  $('render-server-url').addEventListener('change', connect);
  $('render-connect').addEventListener('click', connect);

  $('render-open').addEventListener('click', () => {
    panel.hidden = false;
    checkServer();
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
    withBusy('Look still', async (status, onUpdate) => {
      const { depth } = await currentBlast(status);
      const scene = getScene();
      const prompt = $('render-prompt').value;
      for (const [i, seed] of seeds.entries()) {
        const label = seeds.length > 1 ? `Look still ${i + 1}/${seeds.length}` : 'Look still';
        const form = lookForm({ depth, prompt, output: scene.output, seed });
        const final = await runJob('look', form, { server, onUpdate: (s) => onUpdate({ ...s, label }) });
        const blob = await (await fetch(apiUrl(server, final.image_url))).blob();
        const still = { blob, name: `look_${final.id}.png`, width: scene.output.width, height: scene.output.height, key: blast.key, seed, prompt };
        addStill(still);
        if (i === 0) setLook(still.blob, still.name, still.width, still.height, still.key);
        status.textContent = `${label} ready in ${final.seconds}s.`;
      }
      status.textContent += seeds.length > 1
        ? ' Click the still you like in the strip, then render the shot.'
        : ' Happy with it? Render the shot, or generate again with another seed.';
    });
  const seed = () => Number($('render-seed').value) || 42;

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

  $('render-play').addEventListener('click', () => {
    for (const v of [$('render-blast'), $('render-result')]) {
      v.currentTime = 0;
      v.play().catch(() => {});
    }
  });

  $('render-go').addEventListener('click', () =>
    withBusy('Render', async (status, onUpdate) => {
      $('render-download').hidden = true;
      const { mp4 } = await currentBlast(status);
      const scene = getScene();
      const form = renderForm({
        mp4, look: look.blob, lookName: look.name, prompt: $('render-prompt').value,
        output: scene.output, seed: seed(),
      });
      const final = await runRender(form, { server, onUpdate });
      rendered = await (await fetch(apiUrl(server, final.video_url))).blob();
      setUrl($('render-result'), rendered);
      const a = $('render-download');
      a.href = urls.get($('render-result'));
      a.download = `${(scene.name || 'shot').replace(/[^\w.-]+/g, '_')}_render_${final.id}.mp4`;
      a.hidden = false;
      $('render-play').click();
    }),
  );
}
