import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVES, cameraMove, poseAt } from '../src/cameraPath.js';
import { blocksScene, plazaScene } from '../src/presets.js';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const len = (a) => Math.hypot(...a);
// looking down +z in three.js, screen-right is -x
const START = { position: [0, 1.6, -8], target: [0, 1, 0] };
const RIGHT = [-1, 0, 0];
const travel = (m) => {
  const k = cameraMove(m, START, 65).keys;
  return sub(k[k.length - 1].position, k[0].position);
};

test('every move starts at the start pose and ends on the last frame', () => {
  for (const m of Object.keys(MOVES)) {
    const { keys, ease } = cameraMove(m, START, 65);
    assert.deepEqual(keys[0].position, START.position, m);
    assert.equal(keys[0].frame, 0);
    if (m !== 'static') assert.equal(keys[keys.length - 1].frame, 64, m);
    assert.ok(['smooth', 'linear'].includes(ease));
  }
  assert.throws(() => cameraMove('barrel_roll', START, 65), /unknown/);
});

test('moves go the way their names say', () => {
  assert.ok(dot(travel('dolly_in'), [0, 0, 1]) > 1.5);
  assert.ok(dot(travel('dolly_out'), [0, 0, 1]) < -1.5);
  assert.ok(dot(travel('truck_right'), RIGHT) > 3);
  assert.ok(dot(travel('truck_left'), RIGHT) < -3);
  assert.ok(travel('crane_up')[1] > 2);
  assert.ok(travel('crane_down')[1] < 0);
  assert.ok(dot(travel('orbit_right'), RIGHT) > 2);
  assert.ok(dot(travel('orbit_left'), RIGHT) < -2);
  assert.deepEqual(cameraMove('static', START, 65).keys.length, 1);
});

test('dolly and truck keep the framing; crane keeps the subject', () => {
  for (const m of ['dolly_in', 'truck_right']) {
    const [a, b] = cameraMove(m, START, 65).keys;
    const r3 = (v) => v.map((x) => +x.toFixed(3));
    assert.deepEqual(r3(sub(b.target, b.position)), r3(sub(a.target, a.position)), m);
  }
  const crane = cameraMove('crane_up', START, 97).keys;
  assert.deepEqual(crane[1].target, START.target);
  assert.ok(START.position[1] + cameraMove('crane_down', START, 65).keys[1].position[1] - START.position[1] >= 0.3);
});

test('orbit keeps its distance to the subject along an eased arc', () => {
  const { keys, ease } = cameraMove('orbit_left', START, 65);
  assert.equal(ease, 'linear');
  assert.deepEqual(keys.map((k) => k.frame), [0, 8, 16, 24, 32, 40, 48, 56, 64]);
  const flat = (k) => len(sub([k.position[0], 0, k.position[2]], [k.target[0], 0, k.target[2]]));
  assert.ok(keys.every((k) => k.target.join() === keys[0].target.join())); // one pivot
  for (const k of keys) assert.ok(Math.abs(flat(k) - flat(keys[0])) < 0.01);
  assert.ok(flat(keys[0]) > 7);
  // 97 frames still ends exactly on the last one
  assert.equal(cameraMove('orbit_right', START, 97).keys.at(-1).frame, 96);
});

test('far targets (the plaza looks 100 m ahead) get moves sized for a nearby subject', () => {
  const plaza = plazaScene();
  const start = poseAt(plaza.camera.keys, 0);
  const k = cameraMove('dolly_in', start, 65).keys;
  assert.ok(Math.abs(len(sub(k[1].position, k[0].position)) - 2.4) < 1e-6);
  const orbit = cameraMove('orbit_right', start, 65).keys;
  assert.ok(len(sub(orbit[0].target, orbit[0].position)) <= 8.001); // looks at a point 8 m ahead
  // the blocks preset's start pose gives a dolly about as long as make_test_layout.py's (3 m)
  const b = cameraMove('dolly_in', poseAt(blocksScene().camera.keys, 0), 65).keys;
  assert.ok(len(sub(b[1].position, b[0].position)) > 2);
});
