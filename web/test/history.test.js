import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_LIMIT, History } from '../src/history.js';
import { normalizeScene, plazaScene } from '../src/presets.js';

test('undo and redo step through recorded states', () => {
  const s = { n: 0 };
  const h = new History(s);
  assert.equal(h.canUndo, false);
  assert.equal(h.undo(), null);
  for (let i = 1; i <= 3; i++) {
    s.n = i;
    assert.equal(h.record(s), true);
  }
  assert.deepEqual(h.undo(), { n: 2 });
  assert.deepEqual(h.undo(), { n: 1 });
  assert.equal(h.canRedo, true);
  assert.deepEqual(h.redo(), { n: 2 });
  assert.deepEqual(h.redo(), { n: 3 });
  assert.equal(h.redo(), null);
  assert.deepEqual(h.undo(), { n: 2 });
  assert.deepEqual(h.undo(), { n: 1 });
  assert.deepEqual(h.undo(), { n: 0 });
  assert.equal(h.undo(), null);
});

test('snapshots are copies: later edits and edits to what undo returns do not reach the history', () => {
  const s = { list: [1] };
  const h = new History(s);
  s.list.push(2);
  h.record(s);
  s.list.push(3); // edited in place, not recorded
  const back = h.undo();
  assert.deepEqual(back, { list: [1] });
  back.list.push(99);
  assert.deepEqual(h.redo(), { list: [1, 2] });
  assert.deepEqual(h.undo(), { list: [1] });
});

test('a new edit after undo drops the redo steps', () => {
  const h = new History({ n: 0 });
  h.record({ n: 1 });
  h.record({ n: 2 });
  h.undo();
  h.record({ n: 5 });
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.undo(), { n: 1 });
});

test('no change, no step', () => {
  const h = new History({ n: 0 });
  assert.equal(h.record({ n: 0 }), false);
  assert.equal(h.canUndo, false);
  h.record({ n: 1 });
  assert.equal(h.record({ n: 1 }, 'x'), false);
  assert.deepEqual(h.undo(), { n: 0 });
  assert.equal(h.canUndo, false);
});

test('edits in one group (a drag, typing in a field) merge into one step', () => {
  const h = new History({ x: 0 });
  for (let x = 1; x <= 20; x++) h.record({ x }, 'drag:1');
  h.record({ x: 21 }, 'drag:2'); // the next drag is its own step
  h.record({ x: 22 }); // ungrouped edits never merge
  h.record({ x: 23 });
  assert.deepEqual(h.undo(), { x: 22 });
  assert.deepEqual(h.undo(), { x: 21 });
  assert.deepEqual(h.undo(), { x: 20 });
  assert.deepEqual(h.undo(), { x: 0 });
  assert.equal(h.undo(), null);
});

test('after undo, the same group starts a new step instead of merging into an old one', () => {
  const h = new History({ x: 0 });
  h.record({ x: 1 }, 'field');
  h.record({ x: 2 }, 'field');
  h.undo();
  h.redo();
  h.record({ x: 3 }, 'field');
  assert.deepEqual(h.undo(), { x: 2 });
  assert.deepEqual(h.undo(), { x: 0 });
});

test('keeps at most `limit` undo steps, dropping the oldest', () => {
  const h = new History({ n: 0 });
  assert.equal(h.limit, HISTORY_LIMIT);
  for (let n = 1; n <= HISTORY_LIMIT + 30; n++) h.record({ n });
  let last = null;
  let steps = 0;
  for (let s = h.undo(); s; s = h.undo()) {
    last = s;
    steps++;
  }
  assert.equal(steps, HISTORY_LIMIT);
  assert.deepEqual(last, { n: 30 });
  assert.equal(new History({}, { limit: 3 }).limit, 3);
});

test('reset forgets every step', () => {
  const h = new History({ n: 0 });
  h.record({ n: 1 });
  h.undo();
  h.reset({ n: 7 });
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.record({ n: 7 }), false);
});

test('a real scene round-trips through undo with its moving stand-ins and shots', () => {
  const scene = normalizeScene(plazaScene());
  const h = new History(scene);
  const before = structuredClone(scene);
  scene.objects[0].keys = [
    { frame: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { frame: 64, position: [4, 0, 0], rotation: [0, 1, 0] },
  ];
  scene.shots.push(structuredClone(scene.shots[0]));
  h.record(scene);
  assert.deepEqual(h.undo(), before);
  assert.deepEqual(h.redo(), JSON.parse(JSON.stringify(scene)));
});
