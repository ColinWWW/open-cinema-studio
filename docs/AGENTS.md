# Scene agents

An agent can block out a shot before anyone writes the render prompt: from a brief like *"a dock worker
waits beside two containers on a foggy quay at dawn, slow dolly in"* it places the stand-ins, frames each
shot, adds the camera move, checks the framing, and drafts the render prompt. You then adjust the layout in
the editor as usual, and render.

Every agent works through the same **scene tools** (`web/src/agent/tools.js`). That one contract has three
ways in:

| Way in | For | Where |
| --- | --- | --- |
| **Agent panel** in the editor | Typing a brief | **✦ Design with an agent**, bottom left of the view. Runs Claude, Gemini or ChatGPT with your own API key. |
| **`window.ocs.agent`** in the page | Browser agents, Playwright, an MCP bridge, your own model | `ocs.agent.tools`, `ocs.agent.call(name, input)` |
| **`scripts/design-scene.mjs`** | Headless runs, batch jobs, CI | `node web/scripts/design-scene.mjs "brief" -o scene.json` |

## The tools

The definitions are JSON Schema in the Claude API's tool format (`name`, `description`, `input_schema`),
which MCP and most agent frameworks also take. `ocs.agent.tools` returns them.

| Tool | Does |
| --- | --- |
| `get_scene` | The scene as JSON: output settings, objects (with ids), shot cameras |
| `new_scene` | Start over: name, clip length (65/97/121 frames), fog |
| `add_objects` | Add `box`, `person` or `plane` (wall) stand-ins; returns ids |
| `update_object` | Change name, position, size, turn, grey |
| `remove_objects` | Delete by id |
| `animate_object` | Keyed poses: a person walks between them at a steady speed |
| `set_camera` | A shot's lens (fov, lens shift, easing) and keys (position + look-at target per frame) |
| `camera_move` | A standard move from the frame-0 framing: dolly, truck, crane, orbit, locked off |
| `add_shot` / `remove_shot` | Several cameras over the same blocking, cut together in order |
| `view_shot` | A JPEG of what a shot films at a frame (only where there's a renderer: the panel and `ocs.agent`) |
| `suggest_prompt` | The render prompt for the finished shot |

Conventions (also in the agent's system prompt, `web/src/agent/runner.js`):

- Metres, y up, the floor is y = 0, and an object's position is the centre of its base.
- Looking along +z, **+x is on the left** (three.js is right-handed). `view_shot` is the way to check.
- `size` is `[width, height, depth]` for a box, a scale for a person (`[1, 1, 1]` is 1.75 m tall), and
  `[width, height, -]` for a wall. `turn` is degrees about the vertical axis.
- Shots are 0-based. Editing a shot makes it the active one in the editor.

Bad input never reaches the scene: the tool throws a `ToolError` whose message says what to fix
(*"keys[0].frame must be a whole frame from 0 to 64"*). The panel's loop sends it back to the model as an
error result, and the model retries.

## Plugging in your own agent

**In the page.** Anything that can run JavaScript in the editor tab can drive it:

```js
const { tools, call } = window.ocs.agent;
call('new_scene', { name: 'alley_night', frames: 97 });
const { ids } = call('add_objects', { objects: [
  { type: 'box', name: 'van', position: [-2, 0, 6], size: [2, 2.2, 5] },
  { type: 'person', name: 'courier', position: [1, 0, 4], turn: 180 },
] });
call('set_camera', { name: 'wide', fov: 50, keys: [{ frame: 0, position: [0, 1.6, -3], target: [0, 1.2, 6] }] });
call('camera_move', { move: 'truck_left' });
const frame = call('view_shot', { frame: 0 }); // { mediaType: 'image/jpeg', data: base64 }
call('suggest_prompt', { prompt: 'A narrow alley at night, a white delivery van on the right, a courier walking towards it, slow truck left.' });
```

Each call is applied to the live scene as its own undo step; pass `{ group: 'my-session' }` as a third
argument to make a session's calls one step. A suggested prompt fills the Render panel's prompt box.

To run the built-in loop with another model, pass `createMessage`: a function that takes Messages API
params (`system`, `tools`, `messages`) and returns a response in the same shape (`stop_reason`, `content`
with `text` / `tool_use` blocks). The panel shows the run as usual:

```js
await window.ocs.agent.run('a courier crosses an alley at night', { createMessage: myAdapter });
```

**Headless.** `runSceneAgent` and the tools have no DOM, so they run in node:

```bash
cd web
export ANTHROPIC_API_KEY=...        # or `ant auth login`
node scripts/design-scene.mjs "a dock worker beside two containers on a foggy quay, slow dolly in" -o quay.json
node scripts/design-scene.mjs --from quay.json "add a second shot, close on the worker"
```

Pick the model with `--provider claude|gemini|openai` (`-p`) and optionally `--model`; the key comes from
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) or `OPENAI_API_KEY`:

```bash
GEMINI_API_KEY=... node scripts/design-scene.mjs -p gemini "a courier crosses an alley at night"
OPENAI_API_KEY=... node scripts/design-scene.mjs -p openai --model gpt-5.4-mini "a courier crosses an alley at night"
```

It writes the scene JSON (open it with **Load**), prints the drafted prompt, and prints a link that opens
the scene in the live editor. There's no renderer here, so the agent works without `view_shot`.

**An MCP server** is a thin wrapper: list `TOOLS` from `tools.js`, keep a scene in memory, answer each call
with `runTool(scene, name, input)`, and write the scene out as JSON (or a share link with
`shareLink` from `web/src/share.js`).

## The built-in agent: Claude, Gemini or ChatGPT

Pick the model provider in the panel's **Settings** (or with `--provider` in the script). Each provider
keeps its own key, model and relay URL, and the panel uses the one you saved last. All three get the same
system prompt, the same tools and the same loop (`web/src/agent/runner.js`). Each provider has a small
adapter in `web/src/agent/providers/` that translates to and from its own API, using its official SDK.

| Provider | Default model | API, through | Notes |
| --- | --- | --- | --- |
| **Claude** | `claude-opus-5-5`, effort `high` | Messages API, `@anthropic-ai/sdk` | A request the safety classifiers decline is re-run on Anthropic's recommended fallback model (`fallbacks: "default"`). |
| **Gemini** | `gemini-pro-latest` (Google's alias for its newest Pro model), thinking `HIGH` | `generateContent`, `@google/genai` | Each model turn is replayed exactly as returned, so its thought signatures carry over. `view_shot` images go back inside the function response. |
| **ChatGPT** | `gpt-5.5`, reasoning effort `high` | Responses API, `openai` | Stateless (`store: false`): each turn's output, encrypted reasoning included, is replayed as returned. `view_shot` images go back as `input_image` in the function output. |

Type any other model id into **Model** (the field suggests a few). The defaults are only a starting point,
since model line-ups change quickly. With the API docs out of reach when this was written, the Gemini and
OpenAI model names come from what each pinned SDK release lists.

A run is at most 40 rounds of tool calls, and **Stop** ends it early. Either way, what it built so far
stays in the editor, and **Ctrl+Z** undoes the whole run at once. (If you edit the scene while it works,
the agent builds on your edit rather than overwriting it, and its run splits into one undo step before your
edit and one after.) Each SDK loads only when its provider
runs, so the editor doesn't download any of them otherwise.

**Your keys.** The panel asks for your own API key for the provider you pick. Keys are kept only in this
browser (`localStorage`: `ocs.claudeKey`, `ocs.geminiKey`, `ocs.openaiKey`) and sent only to that
provider's API (`api.anthropic.com`, `generativelanguage.googleapis.com`, `api.openai.com`) or the relay
URL you set. They never go to this project's servers, the same as the Comfy key (see
[SECURITY.md](SECURITY.md)). Anyone with access to this browser profile can read them, so use keys you can
revoke, with spend limits.
