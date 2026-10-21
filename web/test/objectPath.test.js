import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  editObjectPose, isAnimated, keyObject, normalizeObjectKeys, objectPath, objectPoseAt, offsetObject, unkeyObject,
} from '../src/objectPath.js';
import { normalizeScene } from '../src/presets.js';
import { rescaleShots } from '../src/shots.js';

const person = () => ({ id: 'p', type: 'person', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], grey: 0.8 });
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('a still object stays put; the first key off frame 0 also keys where it stood', () => {
  const o = person();
  assert.equal(isAnimated(o), false);
  assert.deepEqual(objectPoseAt(o, 30).position, [0, 0, 0]);
  keyObject(o, 64, { position: [4, 0, 2], rotation: [0, Math.PI / 2, 0] });
  assert.equal(isAnimated(o), true);
  assert.deepEqual(o.keys.map((k) => k.frame), [0, 64]);
  assert.deepEqual(o.position, [0, 0, 0]); // obj.position stays the frame-0 pose
});

test('it moves at a steady speed between keys, and holds before the first and after the last', () => {
  const o = keyObject(person(), 64, { position: [4, 0, 2], rotation: [0, 0, 0] });
  assert.ok(close(objectPoseAt(o, 16).position, [1, 0, 0.5]));
  assert.ok(close(objectPoseAt(o, 32).position, [2, 0, 1]));
  assert.deepEqual(objectPoseAt(o, 80).position, [4, 0, 2]);
  keyObject(o, 32, { position: [0, 0, 4], rotation: [0, 0, 0] }); // a corner halfway
  assert.ok(close(objectPoseAt(o, 16).position, [0, 0, 2]));
  assert.ok(close(objectPoseAt(o, 48).position, [2, 0, 3]));
});

test('turns take the short way round', () => {
  const deg = (d) => (d * Math.PI) / 180;
  const o = person();
  o.rotation = [0, deg(170), 0];
  keyObject(o, 10, { position: [0, 0, 0], rotation: [0, deg(-170), 0] });
  assert.ok(Math.abs(objectPoseAt(o, 5).rotation[1] - deg(180)) < 1e-9); // through 180°, not through 0°
});

test('moving a keyed object auto-keys it at that frame; a still one just moves', () => {
  const still = editObjectPose(person(), 40, { position: [1, 0, 1], rotation: [0, 0, 0] });
  assert.equal(still.keys, undefined);
  assert.deepEqual(still.position, [1, 0, 1]);
  const o = keyObject(person(), 64, { position: [4, 0, 0], rotation: [0, 0, 0] });
  editObjectPose(o, 64, { position: [5, 0, 0], rotation: [0, 0, 0] });
  assert.deepEqual(o.keys.map((k) => [k.frame, k.position[0]]), [[0, 0], [64, 5]]);
  editObjectPose(o, 20, { position: [1, 0, 3], rotation: [0, 0, 0] });
  assert.deepEqual(o.keys.map((k) => k.frame), [0, 20, 64]);
  editObjectPose(o, 0, { position: [-1, 0, 0], rotation: [0, 0, 0] });
  assert.deepEqual(o.position, [-1, 0, 0]); // keying frame 0 moves the start pose too
});

test('removing keys down to one leaves it still at that pose', () => {
  const o = keyObject(person(), 64, { position: [4, 0, 2], rotation: [0, 1, 0] });
  unkeyObject(o, 0);
  assert.equal(isAnimated(o), false);
  assert.equal(o.keys, undefined);
  assert.deepEqual(o.position, [4, 0, 2]);
  assert.deepEqual(o.rotation, [0, 1, 0]);
  assert.deepEqual(unkeyObject(person(), 0).position, [0, 0, 0]); // no keys: nothing to remove
});

test('offset, path and keys that survive a reload and a new clip length', () => {
  const o = keyObject(person(), 64, { position: [4, 0, 0], rotation: [0, 0, 0] });
  offsetObject(o, [1, 0, 0]);
  assert.deepEqual(o.keys.map((k) => k.position[0]), [1, 5]);
  assert.equal(objectPath(o, 65).length, 65);
  assert.deepEqual(objectPath(person(), 65), []);

  const scene = normalizeScene({ objects: [JSON.parse(JSON.stringify(o))] });
  assert.deepEqual(scene.objects[0].keys.map((k) => k.frame), [0, 64]);
  rescaleShots(scene, 65, 97); // the editor stretches object keys with the camera keys
  assert.deepEqual(scene.objects[0].keys.map((k) => k.frame), [0, 96]);
});

test('malformed keys in a loaded scene are dropped, never a crash', () => {
  assert.equal(normalizeObjectKeys('nope'), undefined);
  assert.equal(normalizeObjectKeys([{ frame: 0, position: [0, 0, 0] }]), undefined); // one key: still
  const keys = normalizeObjectKeys([
    { frame: 10, position: [1, 0, 0] }, // no rotation: 0
    { frame: -1, position: [0, 0, 0] },
    { frame: 1.5, position: [0, 0, 0] },
    { frame: 0, position: [0, 'x', 0] },
    { frame: 0, position: [0, 0, 0], rotation: [0, 1, 0] },
    { frame: 10, position: [9, 9, 9] }, // duplicate frame
  ]);
  assert.deepEqual(keys, [
    { frame: 0, position: [0, 0, 0], rotation: [0, 1, 0] },
    { frame: 10, position: [1, 0, 0], rotation: [0, 0, 0] },
  ]);
  const scene = normalizeScene({ objects: [{ ...person(), position: [7, 7, 7], keys }] });
  assert.deepEqual(scene.objects[0].position, [0, 0, 0]); // the base pose follows the first key
});
