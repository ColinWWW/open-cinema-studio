import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeScene, plazaScene } from '../src/presets.js';
import { HASH_KEY, MAX_HASH, TOO_LONG, decodeScene, encodeScene, hasSharedScene, shareLink } from '../src/share.js';

const PAGE = 'https://colinwww.github.io/open-cinema-studio/';

function plazaWithBox() {
  const scene = normalizeScene(plazaScene());
  scene.objects.push({ id: 'added', name: 'crate', type: 'box', position: [1.2300000000000002, 0.5, 3], rotation: [0, 0.7853981633974483, 0], scale: [1, 1, 1], grey: 0.6 });
  return normalizeScene(scene);
}

test('a shared link opens the same scene', async () => {
  const scene = plazaWithBox();
  const link = await shareLink(scene, `${PAGE}#old`);
  assert.equal(link.ok, true);
  assert.ok(link.url.startsWith(`${PAGE}#${HASH_KEY}`), 'replaces the old hash');
  assert.match(link.url.split('#')[1].slice(HASH_KEY.length), /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  assert.ok(link.url.length - PAGE.length < MAX_HASH);

  const back = await decodeScene(`#${link.url.split('#')[1]}`);
  // Numbers are rounded to 4 decimals on the way, so compare with that tolerance.
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} vs ${b}`);
  assert.equal(back.name, scene.name);
  assert.equal(back.objects.length, scene.objects.length);
  back.objects.forEach((o, i) => {
    const want = scene.objects[i];
    assert.deepEqual([o.id, o.name, o.type], [want.id, want.name, want.type]);
    ['position', 'rotation', 'scale'].forEach((k) => o[k].forEach((v, j) => close(v, want[k][j])));
  });
  assert.equal(back.objects.at(-1).position[0], 1.23);
  assert.deepEqual(back.output, scene.output);
  assert.equal(JSON.stringify(back.shots.map((s) => s.camera.keys.length)), JSON.stringify(scene.shots.map((s) => s.camera.keys.length)));
});

test('the hash works with or without its #', async () => {
  const hash = await encodeScene(plazaScene());
  assert.ok(hasSharedScene(hash) && hasSharedScene(`#${hash}`));
  assert.equal((await decodeScene(hash)).name, (await decodeScene(`#${hash}`)).name);
});

test('a scene too big for a link gets a friendly message instead', async () => {
  const scene = normalizeScene(plazaScene());
  // Random positions don't compress, so a few hundred boxes is well past 8 KB.
  for (let i = 0; i < 400; i++) {
    scene.objects.push({ id: `b${i}`, name: `box ${i}`, type: 'box', position: [Math.random() * 100, Math.random(), Math.random() * 100], rotation: [0, 0, 0], scale: [1, 1, 1], grey: 0.8 });
  }
  const link = await shareLink(scene, PAGE);
  assert.deepEqual(link, { ok: false, message: TOO_LONG });
  assert.match(TOO_LONG, /Save/);
});

test('damaged or foreign hashes are ignored, never thrown', async () => {
  const good = await encodeScene(plazaScene());
  const bad = [
    undefined, null, 42, '', '#', '#top', '#scene=', '#scene=%%%', '#scene=not base64!',
    `#${good.slice(0, good.length - 20)}`, // cut short by a chat app
    `#${HASH_KEY}${'A'.repeat(MAX_HASH * 3)}`, // absurdly long
    `#${HASH_KEY}${Buffer.from('{"objects":[]}').toString('base64url')}`, // not deflated
  ];
  for (const hash of bad) assert.equal(await decodeScene(hash), null, String(hash).slice(0, 40));

  // Valid deflate around something that isn't a scene object.
  const deflated = async (text) => {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return HASH_KEY + Buffer.from(await new Response(stream).arrayBuffer()).toString('base64url');
  };
  for (const text of ['not json', '[1,2]', 'null', '"scene"']) assert.equal(await decodeScene(await deflated(text)), null, text);

  // A tiny link that inflates to megabytes stops early.
  assert.equal(await decodeScene(await deflated(`{"name":"${'x'.repeat(4 << 20)}"}`)), null);

  // JSON that is an object but not quite a scene still opens, cleaned up by normalizeScene.
  const odd = await decodeScene(await deflated('{"objects":[{"type":"dragon"},{"type":"box"}],"output":{"width":"big"}}'));
  assert.equal(odd.objects.length, 1);
  assert.equal(odd.output.width, normalizeScene({}).output.width);
});
