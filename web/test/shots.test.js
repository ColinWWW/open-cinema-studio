import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeScene, plazaScene } from '../src/presets.js';
import { addShot, moveShot, removeShot, rescaleShots, selectShot, shotStem } from '../src/shots.js';

const linked = (s) => s.camera === s.shots[s.shot].camera;

test('old scenes become one shot, and camera is the active shot camera', () => {
  const s = normalizeScene(plazaScene());
  assert.equal(s.shots.length, 1);
  assert.equal(s.shots[0].name, 'Shot 1');
  assert.ok(linked(s));
  assert.deepEqual(s.camera, plazaScene().camera);
  assert.ok(linked(normalizeScene(null)));
});

test('shots survive a save and reload, active shot included', () => {
  const s = addShot(normalizeScene(plazaScene()));
  s.camera.fov = 30;
  const back = normalizeScene(JSON.parse(JSON.stringify(s)));
  assert.equal(back.shots.length, 2);
  assert.equal(back.shot, 1);
  assert.equal(back.camera.fov, 30);
  assert.equal(back.shots[0].camera.fov, 50);
  assert.ok(linked(back));
  const bad = normalizeScene({ ...JSON.parse(JSON.stringify(s)), shot: 7, shots: [{ camera: { keys: 'x' } }, null] });
  assert.equal(bad.shot, 0);
  assert.deepEqual(bad.shots.map((x) => x.name), ['Shot 1', 'Shot 2']);
});

test('add copies the active camera; edits stay in their own shot', () => {
  const s = normalizeScene(plazaScene());
  addShot(s);
  assert.equal(s.shot, 1);
  assert.ok(linked(s));
  s.camera.keys[0].position[0] = 5;
  assert.equal(s.shots[0].camera.keys[0].position[0], 0);
  selectShot(s, 0);
  assert.ok(linked(s));
  assert.equal(s.camera.keys[0].position[0], 0);
  addShot(s); // inserted after shot 1
  assert.deepEqual(s.shots.map((x) => x.name), ['Shot 1', 'Shot 3', 'Shot 2']);
});

test('remove keeps at least one shot and a valid active shot', () => {
  const s = addShot(addShot(normalizeScene(plazaScene())));
  removeShot(s); // removes Shot 3 (active), Shot 2 becomes active
  assert.deepEqual(s.shots.map((x) => x.name), ['Shot 1', 'Shot 2']);
  assert.equal(s.shot, 1);
  removeShot(s, 0);
  assert.equal(s.shot, 0);
  removeShot(s);
  assert.equal(s.shots.length, 1);
  assert.ok(linked(s));
});

test('move reorders the cut and follows the active shot', () => {
  const s = addShot(addShot(normalizeScene(plazaScene())));
  moveShot(s, 2, -1);
  assert.deepEqual(s.shots.map((x) => x.name), ['Shot 1', 'Shot 3', 'Shot 2']);
  assert.equal(s.shots[s.shot].name, 'Shot 3');
  moveShot(s, 0, -1); // no-op at the start
  assert.equal(s.shots[0].name, 'Shot 1');
  assert.ok(linked(s));
});

test('changing the clip length rescales every shot', () => {
  const s = addShot(normalizeScene(plazaScene()));
  rescaleShots(s, 65, 121);
  assert.deepEqual(s.shots.map((x) => x.camera.keys.at(-1).frame), [120, 120]);
  assert.ok(linked(s));
});

test('shotStem names files by scene, order and shot', () => {
  const s = addShot(normalizeScene(plazaScene()));
  s.shots[1].name = 'Wide / reverse';
  assert.equal(shotStem(s, 1), 'plaza_dolly_in_02_Wide_reverse');
});
