// The scene agent panel end to end, with a scripted model in place of the Claude API (no key, no network):
// the panel opens, the agent's tool calls build the scene live, view_shot renders a real frame, the whole
// run undoes in one step, and the drafted prompt lands in the Render panel.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ocs.replaySeen', '1'));
  await page.goto('./');
  await expect(page.locator('#replay')).toBeHidden();
});

test('scene agent: a scripted run builds the scene, looks through the shot, and hands over the prompt', async ({ page }) => {
  await page.getByRole('button', { name: '✦ Design with an agent' }).click();
  const panel = page.getByRole('region', { name: 'Scene agent' });
  await expect(panel).toBeVisible();
  await expect(page.locator('#agent-mode-chat')).toHaveAttribute('aria-pressed', 'true'); // no key yet: the chat-app way first
  await expect(page.locator('#agent-settings')).toBeHidden();
  await expect(page.locator('#agent-brief')).toBeFocused();

  const before = await page.evaluate(() => window.ocs.scene.objects.length);
  const out = await page.evaluate(async () => {
    const seen = [];
    const script = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'a', name: 'new_scene', input: { name: 'harbour' } },
        { type: 'tool_use', id: 'b', name: 'add_objects', input: { objects: [
          { type: 'box', name: 'container', position: [1.5, 0, 6], size: [2.4, 2.6, 6], grey: 0.7 },
          { type: 'person', name: 'dock worker', position: [-1, 0, 4] },
        ] } },
        { type: 'tool_use', id: 'c', name: 'set_camera', input: { name: 'wide', fov: 50, keys: [{ frame: 0, position: [0, 1.6, -4], target: [0, 1.2, 6] }] } },
      ] },
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'd', name: 'camera_move', input: { move: 'dolly_in' } },
        { type: 'tool_use', id: 'e', name: 'view_shot', input: { frame: 0 } },
      ] },
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'f', name: 'suggest_prompt', input: { prompt: 'A foggy harbour quay at dawn, a rusty shipping container on the right, a dock worker beside it, slow dolly in.' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Blocked a harbour quay with a container and a worker.' }] },
    ];
    const createMessage = async (params) => {
      seen.push(params.messages.at(-1));
      return script.shift();
    };
    const result = await window.ocs.agent.run('a dock worker by a container at dawn', { createMessage });
    const image = seen[2].content.find((r) => r.tool_use_id === 'e').content[1];
    return { summary: result.summary, image, tools: seen.length };
  });

  expect(out.summary).toContain('harbour quay');
  // view_shot rendered the shot camera: a real JPEG of a few kB, not an empty canvas.
  expect(out.image.source.media_type).toBe('image/jpeg');
  expect(out.image.source.data.length).toBeGreaterThan(4000);

  const scene = await page.evaluate(() => window.ocs.scene);
  expect(scene.name).toBe('harbour');
  expect(scene.objects.map((o) => o.name)).toEqual(['container', 'dock worker']);
  expect(scene.shots[0].name).toBe('wide');
  expect(scene.camera.keys).toHaveLength(2);

  // The log and the result in the panel.
  await expect(page.locator('#agent-log li')).toHaveCount(7); // the brief + 6 tool calls
  await expect(page.locator('#agent-summary')).toHaveText('Blocked a harbour quay with a container and a worker.');
  await expect(page.locator('#agent-status')).toContainText('Done');

  // The prompt goes to the Render panel.
  await page.locator('#agent-use-prompt').click();
  await expect(page.locator('#render-panel')).toBeVisible();
  await expect(page.locator('#render-prompt')).toHaveValue(/foggy harbour quay/);
  await page.locator('#render-close').click();

  // One undo takes the whole run back.
  await page.locator('#undo').click();
  expect(await page.evaluate(() => window.ocs.scene.objects.length)).toBe(before);
  expect(await page.evaluate(() => window.ocs.scene.name)).not.toBe('harbour');
});

test('scene agent: tool errors go back to the model, and Esc closes the panel', async ({ page }) => {
  await page.locator('#agent-open').click();
  const out = await page.evaluate(async () => {
    const replies = [];
    const script = [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'update_object', input: { id: 'missing', grey: 0.5 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing to change.' }] },
    ];
    await window.ocs.agent.run('make it darker', { createMessage: async (p) => (replies.push(p.messages.at(-1)), script.shift()) });
    return replies[1].content[0];
  });
  expect(out.is_error).toBe(true);
  expect(out.content).toMatch(/no object with id/);
  await expect(page.locator('#agent-log li.err')).toHaveCount(1);

  await page.locator('#agent-brief').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#agent-panel')).toBeHidden();
  await expect(page.locator('#agent-open')).toBeFocused();
});

test('window.ocs.agent: other agents drive the same tools on the live scene', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { agent } = window.ocs;
    const names = agent.tools.map((t) => t.name);
    const added = agent.call('add_objects', { objects: [{ type: 'box', name: 'van', position: [0, 0, 3], size: [2, 2, 5] }] });
    agent.call('suggest_prompt', { prompt: 'A white van in an alley.' });
    const view = agent.call('view_shot', { frame: 0 });
    let error = null;
    try {
      agent.call('camera_move', { move: 'barrel_roll' });
    } catch (e) {
      error = e.message;
    }
    return { names, added, viewLength: view.data.length, error, objects: window.ocs.scene.objects.map((o) => o.name) };
  });
  expect(r.names).toContain('view_shot');
  expect(r.added.ids[0].name).toBe('van');
  expect(r.objects).toContain('van');
  expect(r.viewLength).toBeGreaterThan(4000);
  expect(r.error).toMatch(/move must be one of/);
  await expect(page.locator('#render-prompt')).toHaveValue('A white van in an alley.');
  await expect(page.locator('#render-panel')).toBeHidden(); // filled, not opened
});

test('scene agent: one key box picks the provider from the key, and the key stays in this browser', async ({ page }) => {
  await page.locator('#agent-open').click();
  await page.locator('#agent-mode-key').click();
  await expect(page.locator('#agent-settings')).toBeVisible();
  await expect(page.locator('#agent-status')).toHaveText('Paste an API key to start.');
  await expect(page.locator('#agent-model')).toBeHidden(); // Model and via wait under Advanced
  await page.locator('#agent-brief').fill('a quiet street');
  await page.locator('#agent-go').click();
  await expect(page.locator('#agent-status')).toHaveText('Paste an API key first, or use your chat app.');

  await page.locator('#agent-key').fill('AIza-test');
  await expect(page.locator('#agent-key-kind')).toHaveText('Gemini key (gemini-pro-latest).');
  await page.locator('#agent-key').fill('sk-ant-test');
  await expect(page.locator('#agent-key-kind')).toHaveText('Claude key (claude-opus-5-5).');
  await page.locator('#agent-advanced summary').click();
  await page.locator('#agent-base').fill('http://relay.example.com');
  await page.locator('#agent-save').click();
  await expect(page.locator('#agent-status')).toContainText('https');
  await page.locator('#agent-base').fill('');
  await page.locator('#agent-key').press('Enter');
  await expect(page.locator('#agent-settings')).toBeHidden();
  await expect(page.locator('#agent-status')).toHaveText('Claude (claude-opus-5-5): key saved in this browser.');
  expect(await page.evaluate(() => localStorage.getItem('ocs.claudeKey'))).toBe('sk-ant-test');

  await page.locator('#agent-settings-btn').click(); // Change key
  await expect(page.locator('#agent-key')).toHaveValue('sk-ant-test');
  await page.locator('#agent-forget').click();
  expect(await page.evaluate(() => localStorage.getItem('ocs.claudeKey'))).toBeNull();
});

test('scene agent: Gemini and OpenAI keys each keep their own model, and the panel reopens where it was', async ({ page }) => {
  await page.locator('#agent-open').click();
  await page.locator('#agent-mode-key').click();
  const provider = page.locator('#agent-provider');
  await expect(provider.locator('option')).toHaveText(['Claude', 'Gemini', 'ChatGPT (OpenAI)']);

  await page.locator('#agent-key').fill('AIza-test');
  await page.locator('#agent-advanced summary').click();
  await expect(provider).toHaveValue('gemini');
  await expect(page.locator('#agent-model')).toHaveAttribute('placeholder', 'gemini-pro-latest');
  await page.locator('#agent-model').fill('gemini-flash-latest');
  await page.locator('#agent-save').click();
  await expect(page.locator('#agent-status')).toHaveText('Gemini (gemini-flash-latest): key saved in this browser.');

  await page.locator('#agent-settings-btn').click();
  await page.locator('#agent-key').fill('sk-test');
  await expect(provider).toHaveValue('openai');
  await expect(page.locator('#agent-model')).toHaveValue('');
  await page.locator('#agent-save').click();
  await expect(page.locator('#agent-status')).toContainText('ChatGPT (OpenAI) (gpt-5.5)');

  const stored = await page.evaluate(() => ({ ...localStorage }));
  expect(stored).toMatchObject({ 'ocs.agentMode': 'key', 'ocs.agentProvider': 'openai', 'ocs.openaiKey': 'sk-test', 'ocs.geminiKey': 'AIza-test', 'ocs.geminiModel': 'gemini-flash-latest' });

  // After a reload the panel opens in key mode, on the provider picked last, with its own settings.
  await page.reload();
  await page.locator('#agent-open').click();
  await expect(page.locator('#agent-mode-key')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#agent-go')).toHaveText('Build');
  await page.locator('#agent-settings-btn').click();
  await expect(page.locator('#agent-key')).toHaveValue('sk-test');
  await page.locator('#agent-advanced summary').click();
  await expect(provider).toHaveValue('openai');
  await provider.selectOption('gemini');
  await expect(page.locator('#agent-key')).toHaveValue('AIza-test');
  await expect(page.locator('#agent-model')).toHaveValue('gemini-flash-latest');
});

test('scene agent, chat-app mode: copy the prompt, paste the reply, and the scene builds in one undo step', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#agent-open').click();
  await expect(page.locator('#agent-go')).toHaveText('Copy prompt');
  await page.locator('#agent-go').click();
  await expect(page.locator('#agent-status')).toHaveText('Describe the shot first.');

  await page.locator('#agent-brief').fill('a dock worker walks past a container, slow dolly in');
  await page.locator('#agent-brief').press('Control+Enter');
  await expect(page.locator('#agent-status')).toHaveText('Prompt copied. Paste it into your chat app, then paste its reply below.');
  await expect(page.locator('#agent-reply')).toBeFocused();
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'); // Windows' clipboard adds \r
  expect(copied).toContain('Brief:\na dock worker walks past a container, slow dolly in');
  expect(copied).toContain('"calls"');
  expect(await page.locator('#agent-chat-prompt').inputValue()).toBe(copied);

  await page.locator('#agent-reply').fill('Sorry, I can only chat.');
  await page.locator('#agent-build-reply').click();
  await expect(page.locator('#agent-status')).toContainText('no JSON in that reply');

  const before = await page.evaluate(() => window.ocs.scene.objects.length);
  const plan = {
    calls: [
      { tool: 'new_scene', input: { name: 'quay' } },
      { tool: 'add_objects', input: { objects: [{ type: 'box', name: 'container', position: [0, 0, 6], size: [6, 2.6, 2.4] }, { type: 'person', name: 'worker', position: [2, 0, 4] }] } },
      { tool: 'animate_object', input: { id: 'worker', keys: [{ frame: 0, position: [2, 0, 4] }, { frame: 64, position: [-1.5, 0, 4] }] } },
      { tool: 'update_object', input: { id: 'ghost', grey: 0.4 } },
      { tool: 'set_camera', input: { name: 'wide', keys: [{ frame: 0, position: [0, 1.6, -4], target: [0, 1.2, 5] }] } },
      { tool: 'camera_move', input: { move: 'dolly_in' } },
      { tool: 'suggest_prompt', input: { prompt: 'A dock worker walks past a rusty container at dawn, slow dolly in.' } },
    ],
    summary: 'A quay with a container and a worker.',
  };
  // Pasting is the last step: the build starts by itself.
  await page.evaluate((text) => navigator.clipboard.writeText(text), '```json\n' + JSON.stringify(plan) + '\n```');
  await page.locator('#agent-reply').fill('');
  await page.locator('#agent-reply').focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('#agent-status')).toHaveText('Built, skipping 1 step(s) the chat got wrong. Ctrl+Z undoes the build.');
  await expect(page.locator('#agent-chat')).toBeHidden();
  await expect(page.locator('#agent-log li')).toHaveCount(8); // the brief + 7 steps
  await expect(page.locator('#agent-log li.err')).toHaveText([/^Changed an object — skipped: /]);
  await expect(page.locator('#agent-summary')).toHaveText('A quay with a container and a worker.');
  const built = await page.evaluate(() => ({ name: window.ocs.scene.name, objects: window.ocs.scene.objects.map((o) => [o.name, !!o.keys]) }));
  expect(built).toEqual({ name: 'quay', objects: [['container', false], ['worker', true]] });

  await page.locator('#agent-use-prompt').click();
  await expect(page.locator('#render-prompt')).toHaveValue('A dock worker walks past a rusty container at dawn, slow dolly in.');
  await page.locator('#render-close').click();

  // One undo takes the whole build back.
  await page.locator('#undo').click();
  expect(await page.evaluate(() => window.ocs.scene.objects.length)).toBe(before);
  expect(await page.evaluate(() => window.ocs.scene.name)).not.toBe('quay');
});

test('scene agent: run() without a brief says so and leaves the panel usable', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const first = await window.ocs.agent.run(undefined, { createMessage: async () => ({ stop_reason: 'end_turn', content: [] }) });
    const second = await window.ocs.agent.run('a quiet street', { createMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing to do.' }] }) });
    return { first, summary: second?.summary };
  });
  expect(out).toEqual({ first: null, summary: 'Nothing to do.' });
  await expect(page.locator('#agent-go')).toBeVisible();
  await expect(page.locator('#agent-brief')).toBeEnabled();
});
