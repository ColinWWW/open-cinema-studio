import { expect, test } from '@playwright/test';
import { DEMO_FILES } from '../src/demo.js';

// Playwright's own Chromium has no H.264, so the clips only decode in Chrome (CI sets PW_CHANNEL=chrome).
const decodes = (video) => video.evaluate(async (v) => {
  if (!v.canPlayType('video/mp4; codecs="avc1.42E01E"')) return 'no-h264';
  for (let i = 0; i < 100 && v.readyState < 2 && !v.error; i++) await new Promise((r) => setTimeout(r, 100));
  return v.error ? `error ${v.error.code}` : v.readyState >= 2 ? 'ok' : `readyState ${v.readyState}`;
});
const expectDecodes = async (video) => {
  const r = await decodes(video);
  if (r === 'no-h264') test.info().annotations.push({ type: 'skipped', description: 'video decode: this browser has no H.264' });
  else expect(r).toBe('ok');
};

test('live page: the demo replay opens by itself and plays the real plaza files', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bad = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/api/')) bad.push(`${r.status()} ${r.url()}`);
  });

  await page.goto('./');
  const replay = page.locator('#replay');
  await expect(replay).toBeVisible();
  await expect(page.locator('#replay-title')).toHaveText('1. Block the shot');

  // The plaza preset is loaded behind the replay.
  await expect.poll(() => page.evaluate(() => window.ocs.scene.name)).toBe('plaza_dolly_in');

  // The layout clip decodes.
  await expectDecodes(page.locator('#replay-layout'));

  // It runs through to the end: look still, then the render beside the layout.
  await expect(page.locator('#replay-title')).toHaveText('3. Paint the look still', { timeout: 15_000 });
  await expect(page.locator('#replay-title')).toHaveText('4. Film it with LTX-2.5', { timeout: 15_000 });
  await expect(page.locator('#replay-end')).toBeVisible({ timeout: 20_000 });
  await expectDecodes(page.locator('#replay-render'));
  await expect(page.locator('#replay-img')).toHaveJSProperty('complete', true);

  await page.locator('#replay-edit').click();
  await expect(replay).toBeHidden();

  // Closed once, it stays closed on the next visit.
  await page.reload();
  await expect(page.locator('header')).toBeVisible();
  await expect(replay).toBeHidden();

  expect(errors).toEqual([]);
  expect(bad).toEqual([]);
});

test('live page: every demo file is in the build', async ({ request }) => {
  for (const name of Object.values(DEMO_FILES)) {
    const res = await request.get(`demo/${name}`);
    expect(res.status(), name).toBe(200);
  }
});

test('live page: the Render panel falls back to the demo without a server', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));
  await page.goto('./');
  await expect(page.locator('#replay')).toBeHidden();
  await page.locator('#render-open').click();
  await expect(page.locator('#render-demo')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#render-go')).toBeDisabled();
});

test('editor: loading the Plaza preset over the default scene asks in the in-app dialog', async ({ page }) => {
  const native = [];
  page.on('dialog', (d) => {
    native.push(d.message());
    d.dismiss();
  });
  await page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));
  await page.goto('./');
  await expect(page.locator('#replay')).toBeHidden();
  const sceneName = () => page.evaluate(() => window.ocs.scene.name);
  const before = await sceneName();
  expect(before).not.toBe('plaza_dolly_in');

  const dialog = page.getByRole('alertdialog', { name: 'Replace the current scene with "Plaza (dolly in)"?' });
  const preset = page.locator('#preset');

  // Esc cancels: the scene stays and focus goes back to the preset menu.
  await preset.focus();
  await preset.selectOption('plaza');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#dialog-ok')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(preset).toBeFocused();
  expect(await sceneName()).toBe(before);
  await expect(preset).toHaveValue('');

  // OK loads it.
  await preset.selectOption('plaza');
  await expect(dialog).toBeVisible();
  if (process.env.DIALOG_SCREENSHOT) await page.screenshot({ path: process.env.DIALOG_SCREENSHOT });
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(sceneName).toBe('plaza_dolly_in');

  expect(native).toEqual([]);
});
