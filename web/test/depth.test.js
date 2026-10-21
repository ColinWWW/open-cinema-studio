import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depthToGray } from '../src/depth.js';

const grey = (rgba, i) => rgba[i * 4];

test('depthToGray: near is white, twice as far is half grey, nothing hit is black', () => {
  // 2x2, WebGL row order (bottom row first): bottom = [2 m, 4 m], top = [sky, 8 m]
  const out = depthToGray(new Float32Array([2, 4, 0, 8]), 2, 2, { percentile: 0 });
  assert.deepEqual([0, 1, 2, 3].map((i) => grey(out, i)), [0, 64, 255, 128]); // top row first
  assert.equal(out[3], 255); // opaque
  assert.equal(out[0], out[1]); // grey: r = g = b
});

test('depthToGray ignores a few stray near pixels', () => {
  const depth = new Float32Array(1000).fill(10);
  depth[0] = 0.1; // one speck right at the lens
  const out = depthToGray(depth, 1000, 1);
  assert.equal(grey(out, 500), 255);
  assert.equal(grey(out, 0), 255); // clamped, not 25500
});

test('depthToGray of an empty view is black', () => {
  const out = depthToGray(new Float32Array(4), 2, 2);
  assert.deepEqual([0, 1, 2, 3].map((i) => grey(out, i)), [0, 0, 0, 0]);
});
