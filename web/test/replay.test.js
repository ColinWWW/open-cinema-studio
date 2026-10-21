import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_FILES } from '../src/demo.js';
import { REPLAY_STEPS, jobLine, replayMs, shouldAutoOpen } from '../src/replay.js';

test('replay steps show demo files and the real A40 timings', () => {
  assert.deepEqual(REPLAY_STEPS.map((s) => s.key), ['layout', 'depth', 'look', 'render']);
  for (const s of REPLAY_STEPS) assert.ok(s.media in DEMO_FILES, s.media);
  assert.deepEqual(REPLAY_STEPS.filter((s) => s.job).map((s) => s.seconds), [51.8, 166]);
});

test('replayMs speeds jobs up but never below 1.5 s', () => {
  assert.equal(replayMs(166), 5533);
  assert.equal(replayMs(10), 1500);
  assert.equal(replayMs(60, 10), 6000);
});

test('jobLine reports progress, then the real time', () => {
  const step = REPLAY_STEPS[3];
  assert.equal(jobLine(step, 0.5), 'Render… 50% (83 s)');
  assert.equal(jobLine(step, 1), 'Render done in 166 s on an A40 (shown 30× faster).');
});

test('the replay opens by itself only on a fresh visit to the static build', () => {
  assert.equal(shouldAutoOpen({ dev: false, server: '', seen: false }), true);
  assert.equal(shouldAutoOpen({ dev: true, server: '', seen: false }), false);
  assert.equal(shouldAutoOpen({ dev: false, server: 'http://127.0.0.1:8190', seen: false }), false);
  assert.equal(shouldAutoOpen({ dev: false, server: '', seen: true }), false);
});
