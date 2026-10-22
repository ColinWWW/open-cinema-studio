// The scene agent's loop: send the brief and the tools, run every tool call the model makes on the scene
// (tools.js), send the results back, until it stops. The model is plugged in as `createMessage(params)`,
// which returns a Claude Messages API response; claudeProvider() makes one for the Claude API, and tests
// (or another provider, adapted to the same shape) pass their own. `host.viewShot` renders a shot for the
// view_shot tool where there's a renderer (the editor); without it the tool isn't offered.

import { describeScene, runTool, toolDefinitions, ToolError } from './tools.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MAX_TURNS = 40;

export const SYSTEM_PROMPT = `You block out shots for Open Cinema Studio. A shot here is grey stand-in geometry plus a keyed camera; a video model (LTX-2.5) later renders a cinematic clip that keeps exactly this layout and camera, painted to match a text prompt. Your job is the layout and camera, built with the tools, before anyone writes the render prompt.

The world: metres, y is up, the floor is y = 0 and every object's position is the centre of its base. When you look along +z, +x is on your LEFT and -x on your right. Turns are degrees about the vertical axis. The camera looks from position to target; eye height is about 1.6 m. Clips run at 24 fps.

How to work:
1. Read the brief and the current scene. If the brief describes a new scene, call new_scene first; if it asks for a change, edit what is there.
2. Block it with simple shapes at real-world sizes (a door is 2.1 m, a car 4.5 x 1.5 x 1.8 m, a storey 3 m). Use a box for anything solid, a person for each character, a plane for thin walls or signs. Name every shape for what it stands in for. Vary grey so neighbouring shapes read apart. Fewer, bigger shapes beat many small ones: the render fills in detail, not layout.
3. Frame each shot with set_camera, and add a move with camera_move or with your own keys. Keep the subject inside the frame for the whole clip, and leave sky in frame when the scene is outdoors.
4. If view_shot is available, look at frame 0 and the last frame of each shot and fix what reads badly (subject cut off, everything tiny, a wall filling the frame).
5. Call suggest_prompt with the render prompt for the finished shot.
6. End with two or three sentences on what you built.

Keep each move physically plausible: people walk at about 1.4 m/s, and camera moves are a few metres over a clip.`;

/** A readable message for a Claude API failure, from the SDK's typed errors. */
export function apiErrorMessage(Anthropic, err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (err instanceof Anthropic.AuthenticationError) return 'The Claude API rejected the API key.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'That key can’t use this model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API: wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Couldn’t reach the Claude API (offline, or the “via” URL is wrong).';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`.replace(/\s+:/, ':');
  return null;
}

/**
 * A createMessage for the Claude API (browser or node). In the browser the key goes straight to `baseURL`
 * (the Claude API, or a relay of yours) from this page; it never touches our servers. The SDK loads on the
 * first call, so the editor doesn't download it until someone runs an agent.
 */
export function claudeProvider({ apiKey, baseURL, model = DEFAULT_MODEL, effort = 'high' } = {}) {
  let sdk = null;
  return async (params, { signal } = {}) => {
    sdk ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => ({
      Anthropic,
      client: new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), dangerouslyAllowBrowser: true }),
    }));
    const { Anthropic, client } = await sdk;
    try {
      return await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          output_config: { effort },
          // A request the safety classifiers decline is re-run on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          ...params,
        },
        { signal },
      );
    } catch (err) {
      const message = apiErrorMessage(Anthropic, err);
      throw message ? new Error(message, { cause: err }) : err;
    }
  };
}

const firstText = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/**
 * Run the agent on `brief`, starting from `scene`. Calls onScene(scene) after every change, onStep(step)
 * for each tool call ({name, input, result | error}), and resolves {scene, prompt, summary}.
 */
export async function runSceneAgent({ brief, scene, createMessage, host = {}, onScene, onStep, signal, maxTurns = MAX_TURNS }) {
  if (typeof brief !== 'string' || !brief.trim()) throw new Error('Describe the scene first.');
  const tools = toolDefinitions({ canView: typeof host.viewShot === 'function' });
  const messages = [
    {
      role: 'user',
      content: `Brief:\n${brief.trim()}\n\nThe scene in the editor now:\n${JSON.stringify(describeScene(scene))}`,
    },
  ];
  let prompt = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    signal?.throwIfAborted();
    const response = await createMessage({ system: SYSTEM_PROMPT, tools, messages }, { signal });
    if (response.stop_reason === 'refusal') {
      throw new Error(`The model declined this brief${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
    }
    // Always send its content back unchanged: thinking blocks have to stay as they came.
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of room before finishing; try a shorter brief.');
      return { scene, prompt, summary: firstText(response.content) };
    }

    const results = [];
    for (const call of calls) {
      signal?.throwIfAborted();
      try {
        let content;
        if (call.name === 'view_shot' && host.viewShot) {
          const shot = call.input?.shot ?? scene.shot;
          const frame = call.input?.frame ?? 0;
          if (!Number.isInteger(shot) || shot < 0 || shot >= scene.shots.length) throw new ToolError(`shot must be 0 to ${scene.shots.length - 1}`);
          if (!Number.isInteger(frame) || frame < 0 || frame >= scene.output.frames) throw new ToolError(`frame must be 0 to ${scene.output.frames - 1}`);
          const image = await host.viewShot(scene, shot, frame);
          content = [
            { type: 'text', text: `Shot ${shot} ("${scene.shots[shot].name}") at frame ${frame}:` },
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          ];
          onStep?.({ name: call.name, input: call.input, result: { shot, frame } });
        } else {
          const out = runTool(scene, call.name, call.input);
          if (out.changed) {
            scene = out.scene;
            onScene?.(scene);
          }
          if (out.prompt) prompt = out.prompt;
          content = JSON.stringify(out.result);
          onStep?.({ name: call.name, input: call.input, result: out.result });
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        onStep?.({ name: call.name, input: call.input, error: err.message });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
      }
    }
    // Every result goes back in one message, so the model keeps making parallel calls.
    messages.push({ role: 'user', content: results });
  }
  throw new Error(`The agent was still working after ${maxTurns} rounds; the scene so far is in the editor.`);
}
