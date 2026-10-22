import { expect, test } from '@playwright/test';

// Undo and redo (web/src/history.js) in the real editor: keys, header buttons, and that typing in one field is one step.

const objects = (page) => page.evaluate(() => window.ocs.scene.objects.map((o) => ({ id: o.id, x: o.position[0] })));
const blur = (page) => page.evaluate(() => document.activeElement?.blur());

test('add a box, move it, Ctrl+Z twice and it is gone; Ctrl+Shift+Z brings it back', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  const start = await objects(page);

  await page.locator('[data-add="box"]').click();
  const box = (await objects(page)).at(-1);
  expect(box.id).not.toBe(start.at(-1)?.id);

  // Typing "12.5" is four input events in one field: one undo step.
  const x = page.locator('[data-field="position"][data-i="0"]');
  await x.focus();
  await x.press('Control+a');
  await x.pressSequentially('12.5', { delay: 20 });
  await blur(page);
  await expect.poll(async () => (await objects(page)).at(-1).x).toBe(12.5);

  await page.keyboard.press('Control+z'); // the move
  await expect.poll(async () => (await objects(page)).at(-1).x).toBe(box.x);
  await expect(page.locator('#inspector')).toBeVisible(); // the box is still selected
  await page.keyboard.press('Control+z'); // the add
  await expect.poll(() => objects(page)).toEqual(start);
  await expect(page.locator('#inspector')).toBeHidden();
  expect(await page.evaluate((id) => window.ocs.world.meshes.has(id), box.id)).toBe(false);

  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await objects(page)).at(-1)).toEqual(box);
  expect(await page.evaluate((id) => window.ocs.world.meshes.has(id), box.id)).toBe(true);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await objects(page)).at(-1).x).toBe(12.5);
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled();

  // The header buttons do the same.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await objects(page)).at(-1).x).toBe(box.x);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => (await objects(page)).at(-1).x).toBe(12.5);

  // Undo survives a reload's save: the restored scene is what gets saved.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400); // the editor saves 300 ms after the last change
  await page.reload();
  expect(await objects(page)).toEqual(start);
  expect(errors).toEqual([]);
});

test('loading a preset can be undone', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));
  await page.goto('./');
  const before = await page.evaluate(() => window.ocs.scene.name);
  await page.locator('#preset').selectOption('plaza');
  await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => page.evaluate(() => window.ocs.scene.name)).toBe('plaza_dolly_in');
  await blur(page);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.ocs.scene.name)).toBe(before);
});
