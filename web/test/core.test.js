import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poseAt, removeKey, rescaleKeys, setKey, smoothstep } from '../src/cameraPath.js';
import { blocksScene, normalizeScene, plazaScene } from '../src/presets.js';
import { checkOutput, snapFrames } from '../src/spec.js';

const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('snapFrames matches make_test_layout.py', () => {
  assert.deepEqual([65, 72, 97, 100, 1].map(snapFrames), [65, 65, 97, 97, 1]);
});

test('checkOutput flags off-spec clips', () => {
  assert.deepEqual(checkOutput({ width: 960, height: 576, frames: 65, fps: 24 }), []);
  assert.equal(checkOutput({ width: 960, height: 544, frames: 65, fps: 24 }).length, 1);
  assert.equal(checkOutput({ width: 960, height: 576, frames: 64, fps: 30 }).length, 2);
});

test('poseAt clamps, hits keys exactly and eases between them', () => {
  const keys = [
    { frame: 0, position: [0, 0, 0], target: [0, 0, 1] },
    { frame: 10, position: [10, 0, 0], target: [10, 0, 1] },
  ];
  assert.deepEqual(poseAt(keys, -5).position, [0, 0, 0]);
  assert.deepEqual(poseAt(keys, 10).position, [10, 0, 0]);
  assert.deepEqual(poseAt(keys, 99).position, [10, 0, 0]);
  assert.ok(close(poseAt(keys, 2.5).position, [10 * smoothstep(0.25), 0, 0]));
  assert.ok(close(poseAt(keys, 2.5, 'linear').position, [2.5, 0, 0]));
  assert.equal(poseAt([], 3), null);
});

test('blocks and plaza presets reproduce the Python camera paths (x mirrored)', () => {
  for (const [scene, py] of [
    [blocksScene(), (s) => [0, 1.6 - 0.2 * s, -7.5 + 3.0 * s]],
    [plazaScene(), (s) => [0, 1.6, 2.0 * s]],
  ]) {
    for (let i = 0; i < 65; i++) {
      const s = smoothstep(i / 64);
      assert.ok(close(poseAt(scene.camera.keys, i).position, py(s), 1e-9), `${scene.name} frame ${i}`);
    }
  }
  const lamp = plazaScene().objects.find((o) => o.name === 'lamp post');
  assert.ok(close(lamp.position, [4.615, 0, 7.595], 1e-9));
});

test('setKey replaces same-frame keys; removeKey and rescaleKeys', () => {
  let keys = [{ frame: 0, position: [0, 0, 0], target: [0, 0, 1] }];
  keys = setKey(keys, { frame: 64, position: [1, 0, 0], target: [1, 0, 1] });
  keys = setKey(keys, { frame: 0, position: [2, 0, 0], target: [2, 0, 1] });
  assert.deepEqual(keys.map((k) => [k.frame, k.position[0]]), [[0, 2], [64, 1]]);
  assert.deepEqual(rescaleKeys(keys, 65, 97).map((k) => k.frame), [0, 96]);
  assert.deepEqual(removeKey(keys, 0).map((k) => k.frame), [64]);
});

test('normalizeScene survives junk and keeps valid data', () => {
  const junk = normalizeScene({ objects: [{ type: 'teapot' }, { type: 'box', position: [1, 'x', 3] }], camera: { keys: 'no' }, output: { width: 1.5 } });
  assert.equal(junk.objects.length, 1);
  assert.deepEqual(junk.objects[0].position, [0, 0, 0]);
  assert.ok(junk.camera.keys.length >= 1);
  assert.equal(junk.output.width, 960);
  const plaza = plazaScene();
  assert.deepEqual(normalizeScene(JSON.parse(JSON.stringify(plaza))), plaza);
});
