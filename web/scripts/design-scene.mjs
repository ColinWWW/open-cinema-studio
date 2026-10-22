#!/usr/bin/env node
// Block out a scene from a text brief with Claude, Gemini or ChatGPT, headless: the same agent and scene tools
// as the editor's agent panel, minus view_shot (there's no renderer here). Writes the scene JSON (open it with
// Load in the editor) and prints a link that opens it, plus the drafted render prompt.
//
//   cd web && ANTHROPIC_API_KEY=... node scripts/design-scene.mjs "a woman in a red coat crosses a rainy street, slow push-in" -o street.json
//   GEMINI_API_KEY=... node scripts/design-scene.mjs --provider gemini "a dock worker by two containers, slow dolly in"
//   OPENAI_API_KEY=... node scripts/design-scene.mjs --provider openai --from street.json "make it two shots: wide, then close on her"

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { normalizeScene, PRESETS } from '../src/presets.js';
import { PROVIDER_IDS, PROVIDERS, createProvider } from '../src/agent/providers/index.js';
import { runSceneAgent } from '../src/agent/runner.js';
import { shareLink } from '../src/share.js';
import { describeStep } from '../src/agent/panel.js';

const PAGE = 'https://colinwww.github.io/open-cinema-studio/';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o', default: 'scene.json' },
    from: { type: 'string' },
    provider: { type: 'string', short: 'p', default: 'claude' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const brief = positionals.join(' ').trim();
if (values.help || !brief) {
  console.error(`usage: node scripts/design-scene.mjs [-p ${PROVIDER_IDS.join('|')}] [--model id] [-o scene.json] [--from start.json] "brief"`);
  process.exit(values.help ? 0 : 2);
}
const provider = Object.hasOwn(PROVIDERS, values.provider) ? PROVIDERS[values.provider] : null;
if (!provider) {
  console.error(`design-scene: --provider must be one of ${PROVIDER_IDS.join(', ')}`);
  process.exit(2);
}
const apiKey = process.env[provider.env] || (values.provider === 'gemini' ? process.env.GOOGLE_API_KEY : undefined);
if (!apiKey && values.provider !== 'claude') {
  console.error(`design-scene: set ${provider.env} to use ${provider.label}`);
  process.exit(2);
}

const start = values.from ? normalizeScene(JSON.parse(fs.readFileSync(values.from, 'utf8'))) : normalizeScene(PRESETS.empty.make());
let result;
try {
  result = await runSceneAgent({
    brief,
    scene: start,
    // With no key here, the Anthropic SDK finds its own (ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
    createMessage: createProvider(values.provider, { apiKey, model: values.model }),
    onStep: (step) => console.error(`  ${step.error ? '!' : '·'} ${describeStep(step)}`),
  });
} catch (err) {
  console.error(`design-scene: ${err.message}`);
  process.exit(1);
}
const { scene, prompt, summary } = result;

fs.writeFileSync(values.out, `${JSON.stringify(scene, null, 2)}\n`);
console.log(`\n${summary}\n`);
if (prompt) console.log(`Render prompt:\n  ${prompt}\n`);
console.log(`Wrote ${values.out} (${scene.objects.length} objects, ${scene.shots.length} shot${scene.shots.length > 1 ? 's' : ''}).`);
const link = await shareLink(scene, PAGE);
console.log(link.ok ? `Open it: ${link.url}` : link.message);
