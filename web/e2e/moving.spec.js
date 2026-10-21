import { expect, test } from '@playwright/test';

// Moving stand-ins (web/src/objectPath.js) in the real editor: Key move, then move it on another frame,
// and it walks there, in the editor, through the playblast export, and after a reload.

const meshX = (page, id) => page.evaluate((i) => +window.ocs.world.meshes.get(i).position.x.toFixed(3), id);
const setFrame = (page, f) =>
  page.locator('#frame').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, f);

test('Key move, then move it on the last frame: the person walks there', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));
  await page.goto('./');

  await page.locator('#preset').selectOption('plaza');
  await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => page.evaluate(() => window.ocs.scene.name)).toBe('plaza_dolly_in');

  await page.locator('[data-add="person"]').click();
  const id = await page.evaluate(() => window.ocs.scene.objects.at(-1).id);
  const x0 = await meshX(page, id);
  await expect(page.locator('#obj-motion')).toHaveText(/^Still/);

  // Key move on frame 0: keyed where it stands on frames 0 and 64, so it can move.
  await page.locator('#obj-key').click();
  await expect(page.locator('#obj-motion')).toHaveText(/Moves: 2 keys \(0, 64\)/);
  await expect(page.locator('#obj-key')).toHaveText('◆ Key here');

  // On the last frame, 4 m along x: auto-keyed there.
  await setFrame(page, 64);
  await page.locator('[data-field="position"][data-i="0"]').fill(String(x0 + 4));
  await expect.poll(() => meshX(page, id)).toBeCloseTo(x0 + 4, 3);
  const keys = await page.evaluate((i) => window.ocs.scene.objects.find((o) => o.id === i).keys.map((k) => [k.frame, k.position[0]]), id);
  expect(keys).toEqual([[0, x0], [64, x0 + 4]]);
  await expect(page.locator('#key-marks span.obj')).toHaveCount(2);

  // Halfway through the shot it's halfway there, and the inspector follows it.
  await setFrame(page, 32);
  expect(await meshX(page, id)).toBeCloseTo(x0 + 2, 3);
  await expect(page.locator('[data-field="position"][data-i="0"]')).toHaveValue(String(x0 + 2));

  // The playblast export walks it through every frame, then puts it back on the editor's frame.
  const canEncode = await page.evaluate(() => typeof VideoEncoder !== 'undefined');
  if (canEncode) {
    const posed = await page.evaluate(async () => {
      const w = window.ocs.world;
      const seen = [];
      const orig = w.poseObjects.bind(w);
      w.poseObjects = (list, f) => (seen.push(f), orig(list, f));
      try {
        await window.ocs.exportPlayblast();
      } finally {
        w.poseObjects = orig;
      }
      return seen;
    });
    expect(posed.slice(0, 65)).toEqual(Array.from({ length: 65 }, (_, i) => i));
    expect(posed.at(-1)).toBe(32);
    expect(await meshX(page, id)).toBeCloseTo(x0 + 2, 3);
  } else {
    test.info().annotations.push({ type: 'skipped', description: 'playblast: this browser has no WebCodecs encoder' });
  }

  // Duplicate keeps the walk, 1 m to the side; ✕ Key on the copy's last frame leaves one key, so it stops moving.
  await page.locator('#duplicate').click();
  const copy = await page.evaluate(() => window.ocs.scene.objects.at(-1));
  expect(copy.keys.map((k) => [k.frame, k.position[0]])).toEqual([[0, x0 + 1], [64, x0 + 5]]);
  await setFrame(page, 64);
  await page.locator('#obj-key-del').click();
  await expect(page.locator('#obj-motion')).toHaveText(/^Still/);
  await setFrame(page, 32);
  expect(await meshX(page, copy.id)).toBeCloseTo(x0 + 1, 3); // still, where its frame-0 key was
  expect(await meshX(page, id)).toBeCloseTo(x0 + 2, 3); // the original still walks

  // It's saved with the scene: after a reload the original still starts at x0 and ends 4 m on.
  await page.waitForTimeout(400); // the editor saves 300 ms after the last change
  await page.reload();
  const again = await page.evaluate((i) => window.ocs.scene.objects.find((o) => o.id === i)?.keys?.map((k) => [k.frame, k.position[0]]), id);
  expect(again).toEqual([[0, x0], [64, x0 + 4]]);
  expect(errors).toEqual([]);
});
