import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT_IDEAS, variantSeeds } from '../src/prompts.js';
import { promptWarnings } from '../src/render.js';

test('every prompt idea passes the prompt checks', () => {
  const all = PROMPT_IDEAS.flatMap((g) => g.prompts);
  assert.ok(all.length >= 6);
  for (const p of all) assert.deepEqual(promptWarnings(p), [], p);
});

test('variantSeeds counts up from the seed', () => {
  assert.deepEqual(variantSeeds(42, 3), [42, 43, 44]);
  assert.deepEqual(variantSeeds(-1, 2), [42, 43]);
  assert.deepEqual(variantSeeds(2 ** 32 - 1, 2), [2 ** 32 - 1, 0]);
});
