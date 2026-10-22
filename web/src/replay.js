// Demo replay: steps through the bundled plaza example (demo.js) the way a real run goes, with the
// real A40 timings, sped up. It opens by itself on the static build when no render server is set,
// so someone opening the live link without a GPU sees the whole pipeline before anything else.

// Timings of the runs that made the files in examples/ (workflows/README.md).
export const REPLAY_STEPS = [
  {
    key: 'layout',
    title: '1. Block the shot',
    text: 'Grey boxes and a keyed dolly-in, blocked in this editor (the Plaza preset behind this panel). '
      + 'The playblast is exported in the browser: 960×576, 65 frames at 24 fps.',
    media: 'layout',
  },
  {
    key: 'depth',
    title: '2. Export frame 0’s depth',
    text: 'The playblast comes with frame 0’s depth map (near = white). It is what keeps the look still on the layout.',
    media: 'depth',
  },
  {
    key: 'look',
    title: '3. Paint the look still',
    text: 'Z-Image-Turbo + the Fun ControlNet Union in depth mode turn the depth and a prompt into a finished first frame, box for box.',
    media: 'look',
    job: 'Look still', seconds: 51.8,
  },
  {
    key: 'render',
    title: '4. Film it with LTX-2.5',
    text: 'LTX-2.5 + the Layout-to-Render IC-LoRA follow the layout clip’s camera and blocking and take the look from the still.',
    media: 'render',
    job: 'Render', seconds: 166,
  },
];

/** How long the replay shows a job's progress bar: the real time divided by `speedup`, at least 1.5 s. */
export function replayMs(seconds, speedup = 30) {
  return Math.max(1500, Math.round((seconds * 1000) / speedup));
}

/** Status line for a job at fraction t (0..1) of its real duration. */
export function jobLine(step, t, speedup = 30) {
  if (t >= 1) return `${step.job} done in ${Math.round(step.seconds)} s on an A40 (shown ${speedup}× faster).`;
  return `${step.job}… ${Math.round(t * 100)}% (${Math.round(t * step.seconds)} s)`;
}

/** Open the replay on first visit to a static build with no render server saved. */
export function shouldAutoOpen({ dev, server, seen }) {
  return !dev && !server && !seen;
}

const SEEN_KEY = 'ocs.replaySeen';

export function loadSeen(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSeen(storage = globalThis.localStorage) {
  try {
    storage.setItem(SEEN_KEY, '1');
  } catch {
    // blocked storage: the replay opens again next time
  }
}

// ---------- DOM ----------

/** Wire the replay panel. `demo` holds the demo file URLs; `onStart` loads the plaza scene behind it. */
export function initReplay({ demo, onStart, onRender, autoOpen = false }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('replay');
  let run = 0; // a newer start/close cancels older timers
  let opener = null; // what had focus when the replay opened: focus goes back there on close

  const sleep = (ms, mine) => new Promise((resolve, reject) => {
    setTimeout(() => (mine === run ? resolve() : reject(new Error('cancelled'))), ms);
  });

  function show(step, i) {
    $('replay-title').textContent = step.title;
    $('replay-text').textContent = step.text;
    for (const [n, dot] of [...$('replay-dots').children].entries()) dot.classList.toggle('active', n <= i);
    const isVideo = step.media === 'layout' || step.media === 'render';
    const img = $('replay-img');
    img.hidden = isVideo;
    if (!isVideo) img.src = demo[step.media];
    $('replay-videos').hidden = !isVideo;
    $('replay-render-fig').hidden = step.media !== 'render';
    if (isVideo) {
      for (const v of [$('replay-layout'), $('replay-render')]) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
    }
  }

  async function playJob(step, mine) {
    const bar = $('replay-progress');
    const ms = replayMs(step.seconds);
    const t0 = performance.now();
    bar.hidden = false;
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      bar.value = t;
      $('replay-status').textContent = jobLine(step, t);
      if (t >= 1) break;
      await sleep(100, mine);
    }
  }

  async function start() {
    const mine = ++run;
    if (panel.hidden) opener = document.activeElement;
    panel.hidden = false;
    $('replay-close').focus();
    $('replay-end').hidden = true;
    onStart?.();
    try {
      for (const [i, step] of REPLAY_STEPS.entries()) {
        $('replay-status').textContent = '';
        $('replay-progress').hidden = true;
        if (step.job) {
          show({ ...step, media: i ? REPLAY_STEPS[i - 1].media : step.media }, i - 1);
          $('replay-title').textContent = step.title;
          $('replay-text').textContent = step.text;
          await playJob(step, mine);
        }
        show(step, i);
        await sleep(step.media === 'render' ? 2500 : 3500, mine);
      }
      $('replay-progress').hidden = true;
      $('replay-end').hidden = false;
      $('replay-status').textContent = `Look still ${REPLAY_STEPS[2].seconds} s + render ${REPLAY_STEPS[3].seconds} s on an A40, stage 1. Real outputs from examples/.`;
    } catch {
      // closed or restarted
    }
  }

  function close() {
    run++;
    panel.hidden = true;
    for (const v of [$('replay-layout'), $('replay-render')]) v.pause();
    saveSeen();
    // back to ▶ Demo (or whatever opened it); an automatic open had nothing focused, so leave focus be
    if (opener && opener !== document.body && opener.isConnected) opener.focus();
    opener = null;
  }

  $('replay-layout').src = demo.layout;
  $('replay-render').src = demo.render;
  $('replay-dots').replaceChildren(...REPLAY_STEPS.map(() => document.createElement('span')));
  $('replay-open').addEventListener('click', start);
  $('replay-again').addEventListener('click', start);
  $('replay-close').addEventListener('click', close);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
  });
  $('replay-edit').addEventListener('click', close);
  $('replay-render-btn').addEventListener('click', () => {
    close();
    onRender?.();
  });
  if (autoOpen) start();
  return { start, close };
}
