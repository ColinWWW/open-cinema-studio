import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { DEMO_FILES, demoUrls } from '../src/demo.js';

test('demo files exist in examples/', () => {
  for (const name of Object.values(DEMO_FILES)) assert.ok(fs.existsSync(new URL(`../../examples/${name}`, import.meta.url)), name);
});

test('demoUrls follow the base path', () => {
  assert.equal(demoUrls('/').render, '/demo/stage1_genlook_plaza_a40.mp4');
  assert.equal(demoUrls('/open-cinema-studio/').look, '/open-cinema-studio/demo/look_gen_plaza_a40.png');
  assert.equal(demoUrls('/open-cinema-studio').layout, '/open-cinema-studio/demo/layout_plaza_dolly_in.mp4');
  assert.deepEqual(Object.keys(demoUrls()).sort(), ['depth', 'frame0', 'layout', 'look', 'render']);
});
