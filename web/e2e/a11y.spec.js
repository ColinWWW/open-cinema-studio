// Accessibility and small-screen checks: the editor at 1024×768, the note below 900 px, accessible names
// for the icon-only controls, and the editor reachable by keyboard alone with a visible focus ring.
import { expect, test } from '@playwright/test';

const skipReplay = (page) => page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));

// Boxes of the visible elements matching `selector` that stick out of the window or overlap each other.
const layoutProblems = (page, selector) => page.evaluate((sel) => {
  const boxes = [...document.querySelectorAll(sel)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0);
  const name = (el) => el.id || el.textContent.trim().slice(0, 20);
  const problems = [];
  for (const { el, r } of boxes) {
    if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) problems.push(`${name(el)} is outside the window`);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
        problems.push(`${name(boxes[i].el)} overlaps ${name(boxes[j].el)}`);
      }
    }
  }
  if (document.documentElement.scrollWidth > innerWidth) problems.push('the page scrolls sideways');
  return problems;
}, selector);

// The focused element, and whether it shows a focus ring.
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  const ringed = el.closest('.file-btn') || el;
  const s = getComputedStyle(ringed);
  return { id: el.id, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 };
});

// Tab forward until `id` has focus (at most `max` presses); returns every id passed on the way.
async function tabTo(page, id, max = 60) {
  const seen = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    seen.push(f.id);
    expect(f.ring, `focus ring on #${f.id}`).toBe(true);
    if (f.id === id) return seen;
  }
  throw new Error(`Tab never reached #${id}; went through ${seen.join(', ')}`);
}

test.describe('at 1024×768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('header, side panel and timeline fit without overflow or overlap', async ({ page }) => {
    await skipReplay(page);
    await page.goto('./');
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('#small-screen')).toBeHidden();
    expect(await layoutProblems(page, 'header > *')).toEqual([]);
    expect(await layoutProblems(page, 'footer > *')).toEqual([]);
    expect(await layoutProblems(page, '#panel .row > *, #panel .wide, #panel .xyz, #panel h2')).toEqual([]);
    // The side panel scrolls on its own, sideways never.
    expect(await page.locator('#panel').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('the Render panel and the demo replay fit in the window', async ({ page }) => {
    await skipReplay(page);
    await page.goto('./');
    await page.locator('#render-open').click();
    await expect(page.locator('#render-panel')).toBeVisible();
    expect(await layoutProblems(page, '#render-panel')).toEqual([]);
    expect(await layoutProblems(page, '#render-panel .render-head > *')).toEqual([]);
    await page.locator('#render-close').click();
    await page.locator('#replay-open').click();
    await expect(page.locator('#replay')).toBeVisible();
    expect(await layoutProblems(page, '#replay')).toEqual([]);
  });
});

test('below 900 px wide: a polite note, and no sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await skipReplay(page);
  await page.goto('./');
  await expect(page.getByRole('note')).toContainText('best on a desktop browser');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await layoutProblems(page, 'header > *')).toEqual([]);
});

test('icon-only controls have accessible names', async ({ page }) => {
  await skipReplay(page);
  await page.goto('./');
  for (const name of ['Play or pause', 'Previous camera key', 'Next camera key', 'Key the shot camera here',
    'Delete the camera key at this frame', 'Move shot earlier', 'Move shot later', 'Delete shot', 'Demo replay']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('slider', { name: 'Frame' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Camera move' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Shot name' })).toBeVisible();

  // Every visible control has some name.
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea')]
    .filter((el) => el.getClientRects().length && !el.closest('[hidden]'))
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.title || (el.tagName === 'BUTTON' && el.textContent.trim())))
    .map((el) => el.id || el.outerHTML.slice(0, 60)));
  expect(unnamed).toEqual([]);
});

test('keyboard: Tab reaches the header, side panel, timeline and Render panel with a visible focus ring', async ({ page }) => {
  await skipReplay(page);
  await page.goto('./');
  await expect(page.locator('#replay')).toBeHidden();

  const header = await tabTo(page, 'render-open');
  expect(header[0]).toBe('preset');
  expect(header).toContain('load-json'); // the Load file picker is reachable, not just clickable

  // Render… opens with Enter, and the next Tab is inside the panel.
  await page.keyboard.press('Enter');
  await expect(page.locator('#render-panel')).toBeVisible();
  await page.keyboard.press('Tab');
  expect((await focused(page)).id).toBe('render-close');
  await tabTo(page, 'render-look', 20);
  await page.locator('#render-close').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#render-panel')).toBeHidden();

  // Then through the side panel to the timeline.
  const rest = await tabTo(page, 'frame');
  for (const id of ['shot-add', 'shot-name', 'pilot', 'cam-fov', 'cam-move', 'cam-move-apply', 'play', 'prev-key', 'set-key', 'del-key', 'next-key']) {
    expect(rest).toContain(id);
  }
  expect(rest.indexOf('cam-move-apply')).toBeLessThan(rest.indexOf('play'));
});

test('keyboard: on a first visit the demo replay is the first thing Tab reaches', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#replay')).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await focused(page)).toEqual({ id: 'replay-close', ring: true });
  await page.keyboard.press('Enter');
  await expect(page.locator('#replay')).toBeHidden();
});
