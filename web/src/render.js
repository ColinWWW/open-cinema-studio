// Render panel: send the playblast + a look still + a prompt to the render server (server/app.py,
// which runs our core-node LTX-2.5 workflow through the Comfy SDK) and show the result next to the
// playblast. The dev server proxies /api/render and /api/health to it.

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

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

/** Submit a job ('render' or 'look') and poll until it ends. Resolves with the final state; throws on failure. */
export async function runJob(kind, form, { fetchFn = fetch, onUpdate, pollMs = 1000, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let state = await json(await fetchFn(`/api/${kind}`, { method: 'POST', body: form }));
  onUpdate?.(state);
  while (state.status === 'queued' || state.status === 'running') {
    await wait(pollMs);
    state = await json(await fetchFn(`/api/${kind}/${state.id}`));
    onUpdate?.(state);
  }
  if (state.status !== 'succeeded') throw new Error(state.error || `${kind} ${state.status}`);
  return state;
}

export const runRender = (form, opts) => runJob('render', form, opts);

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
 */
export function initRenderPanel({ getScene, exportPlayblast }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('render-panel');
  let look = null; // {blob, name, width, height}
  let blast = null; // {mp4, firstFrame, depth, key}
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
    const hints = [...promptWarnings($('render-prompt').value)];
    const aspect = aspectWarning(look, getScene().output);
    if (aspect) hints.push(aspect);
    if (look?.key && look.key !== sceneKey()) hints.push('The shot changed since this look still was generated: generate it again so it matches.');
    if (!look) hints.unshift('Add a look still: generate one from the layout, or choose frame 0 restyled with any image model.');
    $('render-hints').textContent = hints.join(' ');
    const noPrompt = !$('render-prompt').value.trim();
    $('render-go').disabled = busy || !look || noPrompt;
    $('render-generate').disabled = busy || noPrompt;
  };

  // key: the scene the still was generated from (null for a chosen file)
  const setLook = (blob, name, width, height, key = null) => {
    look = { blob, name, width, height, key };
    setUrl($('render-look-img'), blob);
    refreshHints();
  };

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
        status.textContent = `${label}: ${describeState(s)}`;
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
    try {
      const h = await json(await fetch('/api/health'));
      $('render-server').textContent = `Render server: ${h.target}`;
      $('render-server').classList.remove('bad');
    } catch {
      $('render-server').textContent = 'Render server not reachable. Start it with: python -m server.app';
      $('render-server').classList.add('bad');
    }
  }

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

  $('render-generate').addEventListener('click', () =>
    withBusy('Look still', async (status, onUpdate) => {
      const { depth } = await currentBlast(status);
      const scene = getScene();
      const form = lookForm({
        depth, prompt: $('render-prompt').value, output: scene.output, seed: Number($('render-seed').value) || 42,
      });
      const final = await runJob('look', form, { onUpdate });
      const still = await (await fetch(final.image_url)).blob();
      setLook(still, `look_${final.id}.png`, scene.output.width, scene.output.height, blast.key);
      status.textContent = `Look still ready in ${final.seconds}s. Happy with it? Render the shot, or generate again with another seed.`;
    }),
  );

  $('render-play').addEventListener('click', () => {
    for (const v of [$('render-blast'), $('render-result')]) {
      v.currentTime = 0;
      v.play();
    }
  });

  $('render-go').addEventListener('click', () =>
    withBusy('Render', async (status, onUpdate) => {
      $('render-download').hidden = true;
      const { mp4 } = await currentBlast(status);
      const scene = getScene();
      const form = renderForm({
        mp4, look: look.blob, lookName: look.name, prompt: $('render-prompt').value,
        output: scene.output, seed: Number($('render-seed').value) || 42,
      });
      const final = await runRender(form, { onUpdate });
      const video = await (await fetch(final.video_url)).blob();
      setUrl($('render-result'), video);
      const a = $('render-download');
      a.href = urls.get($('render-result'));
      a.download = `${(scene.name || 'shot').replace(/[^\w.-]+/g, '_')}_render_${final.id}.mp4`;
      a.hidden = false;
      $('render-play').click();
    }),
  );
}
