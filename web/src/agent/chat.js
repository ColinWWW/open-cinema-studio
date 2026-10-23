// "Use your chat app": the scene agent without an API key. The page writes one prompt (the agent's
// instructions, the tools, the brief and the scene) for the visitor to paste into Claude.ai, ChatGPT or
// Gemini, on whatever plan they already have; the reply is the whole plan as one JSON list of tool calls,
// replayed here through the same tools as the API agent (tools.js). It is one exchange, so there's no
// view_shot and no second look. The model can't see the ids add_objects hands out, so it names objects instead.

import { SYSTEM_PROMPT } from './runner.js';
import { TOOLS, ToolError, describeScene, runTool } from './tools.js';

export const MAX_CALLS = 200;

/** The prompt to paste into a chat app for `brief`, starting from `scene`. */
export function chatPrompt(brief, scene) {
  if (typeof brief !== 'string' || !brief.trim()) throw new Error('Describe the shot first.');
  const tools = TOOLS.filter((t) => t.name !== 'get_scene')
    .map((t) => `- ${t.name}: ${t.description}\n  input: ${JSON.stringify(t.input_schema)}`)
    .join('\n');
  return `${SYSTEM_PROMPT}

You can't call the tools in this chat, so plan the whole build at once and reply with it as one JSON object in a single \`\`\`json code block:
{"calls": [{"tool": "<tool name>", "input": {...}}, ...], "summary": "two or three sentences on what you built"}
The calls run in order, exactly as if you had made them yourself. add_objects hands out ids you won't see, so wherever a tool takes an object id (update_object, animate_object, remove_objects), give the object's name instead, and keep names unique. There's no view_shot or get_scene here: the scene is below, so check the framing in your head (the subject in frame from the first frame to the last). End the calls with suggest_prompt.

Tools (name, what it does, its input as JSON Schema):
${tools}

Brief:
${brief.trim()}

The scene in the editor now:
${JSON.stringify(describeScene(scene))}`;
}

/** The JSON text in a chat reply: a ```json block if there is one, else the outermost {...} or [...]. */
function jsonText(reply) {
  for (const m of reply.matchAll(/```[a-z]*\s*\n?([\s\S]*?)```/gi)) {
    const body = m[1].trim();
    if (body.startsWith('{') || body.startsWith('[')) return body;
  }
  const start = reply.search(/[{[]/);
  const end = Math.max(reply.lastIndexOf('}'), reply.lastIndexOf(']'));
  return start >= 0 && end > start ? reply.slice(start, end + 1) : null;
}

/** {calls: [{name, input}], summary} from a pasted chat reply. Throws with a message for the visitor. */
export function parseChatReply(reply) {
  const body = typeof reply === 'string' ? jsonText(reply) : null;
  if (!body) throw new Error('There’s no JSON in that reply: paste the whole reply, including its ```json block.');
  let plan;
  try {
    plan = JSON.parse(body);
  } catch {
    throw new Error('The JSON in that reply doesn’t parse (cut off?): ask the chat to send the whole JSON again.');
  }
  if (Array.isArray(plan)) plan = { calls: plan };
  const calls = plan && typeof plan === 'object' ? plan.calls : null;
  if (!Array.isArray(calls) || !calls.length) throw new Error('That reply has no "calls" list: ask the chat to answer in the JSON format from the prompt.');
  if (calls.length > MAX_CALLS) throw new Error(`That plan has ${calls.length} steps; at most ${MAX_CALLS} are allowed.`);
  return {
    calls: calls.map((c, i) => {
      const name = c?.tool ?? c?.name;
      if (typeof name !== 'string') throw new Error(`Step ${i + 1} in that reply has no "tool".`);
      return { name, input: c.input ?? {} };
    }),
    summary: typeof plan.summary === 'string' ? plan.summary.trim() : '',
  };
}

/** `ref` as an object id in `scene`: an id as it is, else the id of the object with that name. */
function idFor(scene, ref) {
  if (typeof ref !== 'string' || scene.objects.some((o) => o.id === ref)) return ref;
  const want = ref.trim().toLowerCase();
  return scene.objects.find((o) => o.name.trim().toLowerCase() === want)?.id ?? ref;
}

function withIds(scene, name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input; // runTool says what's wrong
  if (name === 'update_object' || name === 'animate_object') return { ...input, id: idFor(scene, input.id) };
  if (name === 'remove_objects' && Array.isArray(input.ids)) return { ...input, ids: input.ids.map((r) => idFor(scene, r)) };
  return input;
}

/**
 * Run a parsed plan's calls on `scene`, in order. A call the tools refuse is skipped (there's no model to send
 * the error back to) and reported with onStep({name, input, error, skipped}). Resolves {scene, prompt, errors}.
 */
export async function replayChatCalls({ scene, calls, onScene, onStep }) {
  let prompt = null;
  let errors = 0;
  for (const { name, input } of calls) {
    try {
      const out = runTool(scene, name, withIds(scene, name, input));
      if (out.changed) {
        scene = out.scene;
        await onScene?.(scene);
      }
      if (out.prompt) prompt = out.prompt;
      onStep?.({ name, input, result: out.result });
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      errors++;
      onStep?.({ name, input, error: err.message, skipped: true });
    }
  }
  return { scene, prompt, errors };
}
