import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfirm, dialogKey, nextFocus } from '../src/dialog.js';

// Just enough DOM for createConfirm: listeners, focus, hidden and textContent.
class FakeEl {
  constructor(doc, name, parent = null) {
    Object.assign(this, { doc, name, parent, hidden: false, textContent: '', listeners: {} });
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, props = {}) {
    let stopped = false;
    const e = { type, target: this, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...props };
    for (let el = this; el && !stopped; el = el.parent) for (const fn of el.listeners[type] ?? []) fn(e);
    if (!stopped) for (const fn of this.doc.listeners[type] ?? []) fn(e);
    return e;
  }
  contains(el) {
    for (; el; el = el.parent) if (el === this) return true;
    return false;
  }
  focus() {
    this.doc.activeElement = this;
    this.dispatch('focusin');
  }
}

function setup() {
  const doc = { listeners: {}, activeElement: null, addEventListener: FakeEl.prototype.addEventListener };
  const opener = new FakeEl(doc, 'opener');
  const root = new FakeEl(doc, 'root');
  root.hidden = true;
  const box = new FakeEl(doc, 'box', root);
  const els = { root, box, message: new FakeEl(doc, 'message', box), ok: new FakeEl(doc, 'ok', box), cancel: new FakeEl(doc, 'cancel', box) };
  const ask = createConfirm({ ...els, doc });
  opener.focus();
  const key = (key, extra) => doc.activeElement.dispatch('keydown', { key, ...extra });
  return { ask, doc, opener, key, ...els };
}

test('dialogKey: Enter confirms, Esc cancels, Tab is trapped, other keys do nothing', () => {
  assert.equal(dialogKey('Enter'), 'confirm');
  assert.equal(dialogKey('Escape'), 'cancel');
  assert.equal(dialogKey('Esc'), 'cancel');
  assert.equal(dialogKey('Tab'), 'trap');
  assert.equal(dialogKey('Delete'), null);
  assert.equal(dialogKey(' '), null);
});

test('nextFocus wraps both ways and pulls stray focus back in', () => {
  const [a, b, c] = ['a', 'b', 'c'];
  assert.equal(nextFocus([a, b, c], a), b);
  assert.equal(nextFocus([a, b, c], c), a);
  assert.equal(nextFocus([a, b, c], a, true), c);
  assert.equal(nextFocus([a, b, c], 'outside'), a);
  assert.equal(nextFocus([a, b, c], 'outside', true), c);
  assert.equal(nextFocus([], a), null);
});

test('opens with the message, focuses OK and resolves true on OK', async () => {
  const d = setup();
  const answer = d.ask('Delete "Shot 2"?', { ok: 'Delete' });
  assert.equal(d.root.hidden, false);
  assert.equal(d.message.textContent, 'Delete "Shot 2"?');
  assert.equal(d.ok.textContent, 'Delete');
  assert.equal(d.cancel.textContent, 'Cancel');
  assert.equal(d.doc.activeElement, d.ok);
  d.ok.dispatch('click');
  assert.equal(await answer, true);
  assert.equal(d.root.hidden, true);
  assert.equal(d.doc.activeElement, d.opener, 'focus goes back to what opened it');
});

test('Cancel, Esc and a click on the backdrop resolve false', async () => {
  const d = setup();
  let answer = d.ask('A?');
  d.cancel.dispatch('click');
  assert.equal(await answer, false);

  answer = d.ask('B?');
  d.key('Escape');
  assert.equal(await answer, false);

  answer = d.ask('C?');
  d.box.dispatch('click'); // inside the box: stays open
  assert.equal(d.root.hidden, false);
  d.root.dispatch('click');
  assert.equal(await answer, false);
});

test('Enter confirms, unless the user tabbed to Cancel', async () => {
  const d = setup();
  let answer = d.ask('A?');
  assert.equal(d.key('Enter').defaultPrevented, true);
  assert.equal(await answer, true);

  answer = d.ask('B?');
  d.key('Tab');
  assert.equal(d.doc.activeElement, d.cancel);
  d.key('Enter');
  assert.equal(await answer, false);
});

test('Tab and Shift+Tab stay inside the dialog, and outside focus is pulled back', async () => {
  const d = setup();
  const answer = d.ask('A?');
  d.key('Tab');
  assert.equal(d.doc.activeElement, d.cancel);
  d.key('Tab');
  assert.equal(d.doc.activeElement, d.ok);
  d.key('Tab', { shiftKey: true });
  assert.equal(d.doc.activeElement, d.cancel);
  d.opener.focus();
  assert.equal(d.doc.activeElement, d.ok);
  d.key('Escape');
  await answer;
});

test("keys don't reach the editor's shortcuts while it is open", async () => {
  const d = setup();
  const seen = [];
  d.doc.addEventListener('keydown', (e) => seen.push(e.key));
  const answer = d.ask('A?');
  d.key('Delete');
  d.key(' ');
  d.key('Escape');
  await answer;
  assert.deepEqual(seen, []);
  d.opener.dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(seen, ['Delete']);
});

test('a second request answers the first with Cancel', async () => {
  const d = setup();
  const first = d.ask('A?');
  const second = d.ask('B?');
  assert.equal(await first, false);
  assert.equal(d.message.textContent, 'B?');
  d.ok.dispatch('click');
  assert.equal(await second, true);
});

test('clicks after it closes do nothing', async () => {
  const d = setup();
  const answer = d.ask('A?');
  d.ok.dispatch('click');
  d.cancel.dispatch('click');
  assert.equal(await answer, true);
});
