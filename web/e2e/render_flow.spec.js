import { expect, test } from '@playwright/test';

// The Render panel against the real render server, with the mock ComfyUI standing in for the GPU
// (playwright.render.config.js starts the chain). The mock "renders" by sending back the uploaded clip and
// "paints" a look still by sending back the depth map, so every file the page shows went through the server.

const PROMPT = 'A sunny stone plaza with a lamp post, wooden crates and a kiosk, slow push-in, golden hour.';
const FINISHED = ['succeeded', 'failed', 'cancelled'];

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
const errors = [];
const jobs = []; // every look/render the page submitted: {kind, id}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => {
    const m = r.request().method() === 'POST' && new URL(r.url()).pathname.match(/^\/api\/(look|render)$/);
    if (!m || r.status() !== 202) return;
    jobs.push({ kind: m[1], id: (await r.json()).id });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ocs.replaySeen', '1');
    // Note the look still each render was sent with (Playwright doesn't expose multipart bodies with files).
    window.renderLooks = [];
    const fetch0 = window.fetch;
    window.fetch = (url, init) => {
      if (String(url).endsWith('/api/render') && init?.body instanceof FormData) window.renderLooks.push(init.body.get('look').name);
      return fetch0(url, init);
    };
  });
  await page.goto('./');
});

test.afterAll(async () => {
  await page?.close();
});

const status = () => page.locator('#render-status');

/** Wait until the panel's work has ended (Cancel shows from the click until the work ends, either way). */
const idle = () => expect(page.locator('#render-cancel')).toBeHidden({ timeout: 180_000 });

/** The video element decodes its clip and its clock moves when played. */
async function expectPlays(video) {
  const r = await video.evaluate(async (v) => {
    if (!v.canPlayType('video/mp4; codecs="avc1.64001f"')) return 'no-h264';
    for (let i = 0; i < 100 && v.readyState < 2 && !v.error; i++) await new Promise((res) => setTimeout(res, 100));
    if (v.error) return `error ${v.error.code}`;
    if (v.readyState < 2) return `readyState ${v.readyState}`;
    await v.play();
    const t0 = v.currentTime;
    await new Promise((res) => setTimeout(res, 500));
    return v.currentTime !== t0 ? 'ok' : 'stuck';
  });
  expect(r).toBe('ok');
}

/** GET /api/<kind>/<id> until it has finished (or the timeout), returning the last status. */
async function finalStatus(request, { kind, id }) {
  let s;
  for (let i = 0; i < 50; i++) {
    s = (await (await request.get(`/api/${kind}/${id}`)).json()).status;
    if (FINISHED.includes(s)) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  return s;
}

test('connects to the render server and loads the Plaza preset', async () => {
  await page.locator('#preset').selectOption('plaza');
  const dialog = page.getByRole('alertdialog', { name: 'Replace the current scene with "Plaza (dolly in)"?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.ocs.scene.name)).toBe('plaza_dolly_in');

  await page.locator('#render-open').click();
  await expect(page.locator('#render-server')).toHaveText(/^Render server: .*8289/);
  await expect(page.locator('#render-demo')).toBeHidden();
  await page.locator('#render-prompt').fill(PROMPT);
  await expect(page.locator('#render-generate')).toBeEnabled();
});

test('generates a look still, then 3 variants, and picks one', async () => {
  await page.locator('#render-generate').click();
  await idle();
  await expect(status()).toHaveText(/^Look still ready in \d+(\.\d+)?s\./);
  const lookImg = page.locator('#render-look-img');
  await expect(lookImg).toHaveJSProperty('naturalWidth', 960); // the mock sends back frame 0's depth map
  const strip = page.locator('#render-variants > button');
  await expect(strip).toHaveCount(1);

  await page.locator('#render-variants-go').click();
  await idle();
  await expect(status()).toHaveText(/Click the still you like in the strip/);
  await expect(strip).toHaveCount(4);
  // newest first: the variant generated first becomes the look; pick the last one instead
  await expect(strip.nth(2)).toHaveClass(/active/);
  const before = await lookImg.getAttribute('src');
  await strip.nth(0).click();
  await expect(strip.nth(0)).toHaveClass(/active/);
  await expect(strip.nth(2)).not.toHaveClass(/active/);
  await expect(lookImg).not.toHaveAttribute('src', before);
  expect(jobs.filter((j) => j.kind === 'look')).toHaveLength(4);
});

test('renders the shot with the picked still, and the result plays', async () => {
  const pickedLook = jobs.filter((j) => j.kind === 'look').at(-1); // the 3rd variant = strip.nth(0)
  await page.locator('#render-go').click();
  await idle();
  await expect(status()).toHaveText(/^Render: Done in /);
  await expect(page.locator('#render-download')).toBeVisible();
  expect(jobs.at(-1).kind).toBe('render');
  expect(await page.evaluate(() => window.renderLooks)).toEqual([`look_${pickedLook.id}.png`]);
  await expectPlays(page.locator('#render-result'));
});

test('renders all shots and cuts them into a sequence that downloads', async ({ request }) => {
  // The panel stays open while shots are added: Render all has to follow the shot list as it changes.
  await expect(page.locator('#render-panel')).toBeVisible();
  await expect(page.locator('#render-all')).toBeDisabled();
  await page.locator('#shot-add').click();
  await expect(page.locator('#render-all')).toHaveText('Render all 2 shots');
  await expect(page.locator('#render-all')).toBeEnabled();
  await page.locator('#shot-add').click();
  await expect.poll(() => page.evaluate(() => window.ocs.scene.shots.length)).toBe(3);
  await expect(page.locator('#render-all')).toHaveText('Render all 3 shots');

  const stitched = [];
  const onStitch = async (r) => {
    if (new URL(r.url()).pathname === '/api/stitch') stitched.push(await r.json());
  };
  page.on('response', onStitch);
  const first = jobs.length;
  await page.locator('#render-all').click();
  await idle();
  await expect(status()).toHaveText(/^Sequence done: 3 shots, \d+ frames/);
  page.off('response', onStitch);

  const run = jobs.slice(first);
  expect(run.map((j) => j.kind)).toEqual(['look', 'render', 'look', 'render', 'look', 'render']);
  expect(stitched.map((s) => s.status)).toEqual(['succeeded', 'succeeded']); // the renders, and their layout clips

  const link = page.locator('#render-download');
  await expect(link).toHaveText('Download sequence');
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^plaza_dolly_in_sequence_\w+\.mp4$/);
  const fs = await import('node:fs/promises');
  const got = await fs.readFile(await download.path());
  // the browser's copy is the server's sequence (whichever of the two stitches the link came from)
  const servers = await Promise.all(stitched.map(async (s) => (await request.get(s.video_url)).body()));
  expect(servers.some((b) => b.equals(got))).toBe(true);
  expect(got.length).toBeGreaterThan(1000);
  await expect(page.locator('#render-download-layout')).toBeVisible();
  await expectPlays(page.locator('#render-result'));
});

test('Cancel mid-run stops Render all and leaves no job running', async ({ request }) => {
  const first = jobs.length;
  await page.locator('#render-all').click();
  // Cancel just after shot 2's look still is submitted: it has MOCK_DELAY seconds to go, and the panel sends
  // the cancel at once, without waiting for its next poll. Check often: the default backs off to 1 s polls.
  await expect.poll(() => jobs.length, { timeout: 120_000, intervals: [100] }).toBe(first + 3);
  await expect(status()).toHaveText(/^Shot 2\/3 look still: /);
  await page.locator('#render-cancel').click();
  await expect(status()).toHaveText('Sequence cancelled.', { timeout: 30_000 });
  await idle();

  const run = jobs.slice(first);
  expect(run.length).toBeGreaterThanOrEqual(2);
  const finals = await Promise.all(run.map((j) => finalStatus(request, j)));
  const report = run.map((j, i) => `${j.kind} ${j.id}: ${finals[i]}`);
  for (const s of finals) expect(['cancelled', 'succeeded'], report.join('\n')).toContain(s);
  expect(finals, report.join('\n')).toContain('cancelled');

  // nothing else gets submitted after the cancel
  const after = jobs.length;
  await page.waitForTimeout(3000);
  expect(jobs.length).toBe(after);
  await expect(page.locator('#render-all')).toBeEnabled();
});

test('no page errors along the way', () => {
  expect(errors).toEqual([]);
});
