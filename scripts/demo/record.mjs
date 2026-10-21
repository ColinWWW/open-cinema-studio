#!/usr/bin/env node
// Records the editor beats of docs/submission/DEMO_SCRIPT.md from the production build at 1920×1080,
// with no GPU and no render server: Playwright drives the page and records one video, and every beat's
// start and end go into beats.json so assemble.sh can cut them out.
//
//   node scripts/demo/record.mjs            # writes demo/raw/editor.webm and demo/raw/beats.json
//   PW_CHANNEL=chrome node scripts/demo/record.mjs   # real Chrome: H.264, so the Render panel's videos play
//
// Options: --headed (watch it), --out <dir> (default demo/raw), --no-build (reuse web/dist).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = path.join(ROOT, 'web');
// Playwright is a dev dependency of web/, so load it from there.
const { chromium } = createRequire(path.join(WEB, 'package.json'))('@playwright/test');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const OUT = path.resolve(ROOT, opt('--out', 'demo/raw'));
const PORT = Number(process.env.DEMO_PORT || 4180);
const URL_ = `http://127.0.0.1:${PORT}/`;
const W = 1920;
const H = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
  }
  throw new Error(`no answer from ${url}`);
}

// A visible cursor: headless video has none, and the viewer needs to see what is being clicked.
function cursorScript() {
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;
        border-radius: 50%; background: rgba(255,255,255,.85); border: 2px solid #222; z-index: 2147483647;
        pointer-events: none; box-shadow: 0 1px 6px rgba(0,0,0,.5); transition: transform .12s; }
      #demo-cursor.down { transform: scale(.7); background: #ffd54a; }`;
    document.head.append(style);
    const dot = document.createElement('div');
    dot.id = 'demo-cursor';
    document.body.append(dot);
    addEventListener('mousemove', (e) => (dot.style.translate = `${e.clientX}px ${e.clientY}px`), true);
    addEventListener('mousedown', () => dot.classList.add('down'), true);
    addEventListener('mouseup', () => dot.classList.remove('down'), true);
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.webm')) fs.rmSync(path.join(OUT, f));

  if (!flag('--no-build')) {
    const b = spawnSync('npm', ['run', 'build'], { cwd: WEB, stdio: 'inherit', env: { ...process.env, BASE_PATH: '/' } });
    if (b.status !== 0) throw new Error('web build failed (run npm ci in web/ first)');
  }
  const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: WEB,
    stdio: 'ignore',
    detached: true,
  });
  const stopServer = () => {
    try {
      process.kill(-server.pid);
    } catch {
      // already gone
    }
  };
  process.on('exit', stopServer);

  const browser = await chromium.launch({
    headless: !flag('--headed'),
    channel: process.env.PW_CHANNEL || undefined,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    await waitForServer(URL_);
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      recordVideo: { dir: OUT, size: { width: W, height: H } },
    });
    await context.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1')); // no auto replay
    await context.addInitScript(cursorScript);
    const page = await context.newPage();
    const t0 = Date.now(); // the video starts with the page
    page.on('dialog', (d) => d.accept()); // native confirm() in web/src/main.js
    page.on('pageerror', (e) => console.warn('page error:', e.message));

    const beats = [];
    let current = null;
    const begin = (name) => (current = { name, start: (Date.now() - t0) / 1000 });
    const end = () => {
      current.end = (Date.now() - t0) / 1000;
      beats.push(current);
      console.log(`  ${current.name}: ${current.start.toFixed(1)}–${current.end.toFixed(1)} s`);
    };

    // Moves the cursor smoothly to an element (or a point), so clicks read on video.
    // Each mouse step costs a frame, so the step count follows the page's frame rate: a move takes about
    // half a second on a GPU and on a slow software-GL machine alike.
    let steps = 12;
    let mouse = { x: W / 2, y: H / 2 };
    const moveTo = async (target, { dx = 0.5, dy = 0.5 } = {}) => {
      let x = target.x;
      let y = target.y;
      if (x === undefined) {
        const box = await target.boundingBox();
        x = box.x + box.width * dx;
        y = box.y + box.height * dy;
      }
      await page.mouse.move(x, y, { steps });
      mouse = { x, y };
    };
    const click = async (sel, pause = 600) => {
      const el = page.locator(sel);
      await el.waitFor({ state: 'visible' });
      await moveTo(el);
      await sleep(250);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
      await confirmIfAsked();
      await sleep(pause);
    };
    const choose = async (sel, value, pause = 800) => {
      await moveTo(page.locator(sel));
      await sleep(300);
      await page.locator(sel).selectOption(value);
      await confirmIfAsked();
      await sleep(pause);
    };
    // Types into a number field like a person would, then commits it.
    const typeInto = async (sel, value, pause = 400) => {
      const el = page.locator(sel);
      await moveTo(el);
      await el.click({ clickCount: 3 });
      await page.keyboard.type(String(value), { delay: 70 });
      await page.keyboard.press('Tab');
      await sleep(pause);
    };
    // If the app asks with its in-app dialog instead of confirm(), click OK where the viewer can see it.
    const confirmIfAsked = async () => {
      const modal = page.locator('[role="alertdialog"]');
      await sleep(150);
      if (await modal.isVisible().catch(() => false)) {
        const ok = page.locator('#dialog-ok');
        await sleep(500);
        if (await ok.isVisible().catch(() => false)) {
          await moveTo(ok);
          await sleep(250);
          await ok.click();
        } else await page.keyboard.press('Enter');
        await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    };
    const blur = () => page.evaluate(() => document.activeElement?.blur());

    console.log(`Recording ${URL_} (${process.env.PW_CHANNEL || 'chromium'})`);
    await page.goto(URL_);
    await page.locator('header').waitFor();
    await page.mouse.move(mouse.x, mouse.y);
    const fps = await page.evaluate(() => new Promise((done) => {
      let n = 0;
      const t = performance.now();
      const tick = () => (++n === 20 ? done((1000 * n) / (performance.now() - t)) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }));
    steps = Math.max(3, Math.min(20, Math.round(fps * 0.4)));
    console.log(`  page runs at ${fps.toFixed(0)} fps: ${steps} steps per mouse move`);
    await sleep(1500);

    // 0:08 Block: plaza preset, add a box and a person, frame through the shot camera, orbit, play.
    begin('block');
    await sleep(800);
    await choose('#preset', 'plaza', 1500);
    await page.waitForFunction(() => window.ocs.scene.name === 'plaza_dolly_in');
    await click('[data-add="box"]', 700);
    await typeInto('[data-field="position"][data-i="0"]', -1.5);
    await typeInto('[data-field="scale"][data-i="1"]', 1.6, 700);
    await click('[data-add="person"]', 700);
    await typeInto('[data-field="position"][data-i="0"]', 1.2);
    await typeInto('#obj-roty', -30, 900);
    await blur();
    await page.keyboard.press('Escape'); // deselect, so the gizmo isn't in the shot
    await click('#pilot', 1800);
    await choose('#cam-move', 'orbit_right', 500);
    await click('#cam-move-apply', 1200);
    await moveTo({ x: W * 0.62, y: H * 0.55 });
    await blur();
    await page.keyboard.press('Space');
    await sleep(6000); // the 65-frame shot plays twice
    await page.keyboard.press('Space');
    await sleep(500);
    end();

    // 0:30 Playblast: encode the layout clip, frame 0 and depth in the browser. It needs an H.264
    // encoder (WebCodecs), which Chrome has and Playwright's own Chromium doesn't; assemble.py then
    // shows the bundled plaza playblast instead.
    const canEncode = await page.evaluate(async () =>
      typeof VideoEncoder !== 'undefined' &&
      (await VideoEncoder.isConfigSupported({ codec: 'avc1.64001f', width: 960, height: 576, avc: { format: 'avc' } })).supported);
    if (canEncode) {
      begin('playblast');
      await click('#export', 200);
      await page.waitForFunction(() => /^(Done|Export failed)/.test(document.getElementById('export-status').textContent), null, { timeout: 120_000 });
      const status = await page.locator('#export-status').textContent();
      await moveTo(page.locator('#export-links'));
      await sleep(2500);
      await click('#export-close', 600);
      end();
      if (status.startsWith('Export failed')) {
        console.warn(`  playblast: dropped, ${status}`);
        beats.pop();
      }
    } else console.warn('  playblast: skipped, this browser has no H.264 encoder (use PW_CHANNEL=chrome)');

    // 0:40 Render panel: with no server it opens on the bundled A40 example (demo mode).
    begin('render');
    await click('#render-open', 400);
    await page.locator('#render-demo').waitFor({ state: 'visible', timeout: 15_000 });
    await sleep(2000);
    await moveTo(page.locator('#render-look-img'));
    await sleep(1500);
    await choose('#render-ideas', { index: 2 }, 1500);
    await moveTo(page.locator('#render-result'));
    await sleep(4000);
    end();

    const video = page.video();
    await context.close(); // finishes the video file
    const file = path.join(OUT, 'editor.webm');
    fs.renameSync(await video.path(), file);
    fs.writeFileSync(path.join(OUT, 'beats.json'), `${JSON.stringify({ video: 'editor.webm', beats }, null, 2)}\n`);
    console.log(`Wrote ${path.relative(ROOT, file)} and beats.json`);
  } finally {
    await browser.close();
    stopServer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
