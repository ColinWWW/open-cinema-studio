// ChatGPT models through the official `openai` SDK's Responses API, adapted to the loop's Messages API
// shapes. Nothing is stored on OpenAI's side (store: false): each turn's output items, encrypted reasoning
// included, are kept as a `provider_state` block and replayed unchanged on the next request.

export const OPENAI_MODEL = 'gpt-5.5';

const textOf = (content) => (typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));

/** The loop's history as Responses API input items. */
export function toOpenAIInput(messages) {
  return messages.flatMap((m) => {
    if (m.role === 'assistant') {
      const kept = m.content.find((b) => b.type === 'provider_state' && b.provider === 'openai');
      if (kept) return kept.data;
      return m.content.flatMap((b) =>
        b.type === 'text'
          ? [{ role: 'assistant', content: b.text }]
          : b.type === 'tool_use'
            ? [{ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) }]
            : [],
      );
    }
    if (typeof m.content === 'string') return [{ role: 'user', content: m.content }];
    return m.content.map((r) => {
      if (r.type === 'text') return { role: 'user', content: r.text };
      const text = r.is_error ? `Error: ${textOf(r.content)}` : textOf(r.content);
      const images = Array.isArray(r.content) ? r.content.filter((c) => c.type === 'image') : [];
      return {
        type: 'function_call_output',
        call_id: r.tool_use_id,
        output: images.length
          ? [{ type: 'input_text', text }, ...images.map((c) => ({ type: 'input_image', image_url: `data:${c.source.media_type};base64,${c.source.data}` }))]
          : text,
      };
    });
  });
}

/** A Responses API response in the loop's shape: {stop_reason, content, stop_details?}. */
export function fromOpenAIResponse(response) {
  const output = response.output ?? [];
  const content = [{ type: 'provider_state', provider: 'openai', data: output }];
  let calls = 0;
  let refusal = null;
  for (const item of output) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') content.push({ type: 'text', text: c.text });
        if (c.type === 'refusal') refusal = c.refusal;
      }
    } else if (item.type === 'function_call') {
      let input;
      try {
        input = JSON.parse(item.arguments);
      } catch {
        input = null; // the tool says "input must be an object", and the model retries
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
      calls++;
    }
  }
  if (calls) return { stop_reason: 'tool_use', content };
  if (refusal) return { stop_reason: 'refusal', stop_details: { explanation: refusal }, content };
  const why = response.incomplete_details?.reason;
  if (why === 'content_filter') return { stop_reason: 'refusal', stop_details: { explanation: 'OpenAI’s content filter stopped it' }, content };
  if (why === 'max_output_tokens') return { stop_reason: 'max_tokens', content };
  return { stop_reason: 'end_turn', content };
}

/** Tool definitions for the Responses API: the same JSON Schemas, not strict (ours keep optional fields optional). */
export const toOpenAITools = (tools) =>
  tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));

/** A readable message for an OpenAI API failure, from the SDK's typed errors. */
export function openaiErrorMessage(OpenAI, err) {
  if (err instanceof OpenAI.APIUserAbortError) return 'Stopped.';
  if (err instanceof OpenAI.AuthenticationError) return 'The OpenAI API rejected the API key.';
  if (err instanceof OpenAI.PermissionDeniedError) return 'That key can’t use this model.';
  if (err instanceof OpenAI.NotFoundError) return 'The OpenAI API doesn’t know that model.';
  if (err instanceof OpenAI.RateLimitError) return 'Rate limited by the OpenAI API (or out of credit): wait a moment and try again.';
  if (err instanceof OpenAI.APIConnectionError) return 'Couldn’t reach the OpenAI API (offline, or the “via” URL is wrong).';
  if (err instanceof OpenAI.APIError) return `OpenAI API error ${err.status ?? ''}: ${err.message}`.replace(/\s+:/, ':');
  return null;
}

/** A createMessage for the OpenAI API. The SDK loads on the first call. */
export function openaiProvider({ apiKey, baseURL, model = OPENAI_MODEL, effort = 'high' } = {}) {
  let sdk = null;
  return async (params, { signal } = {}) => {
    sdk ??= import('openai').then(({ default: OpenAI }) => ({
      OpenAI,
      client: new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), dangerouslyAllowBrowser: true }),
    }));
    const { OpenAI, client } = await sdk;
    let response;
    try {
      response = await client.responses.create(
        {
          model,
          instructions: params.system,
          input: toOpenAIInput(params.messages),
          tools: toOpenAITools(params.tools),
          reasoning: { effort },
          max_output_tokens: 16000,
          store: false,
          include: ['reasoning.encrypted_content'],
        },
        { signal },
      );
    } catch (err) {
      const message = openaiErrorMessage(OpenAI, err);
      throw message ? new Error(message, { cause: err }) : err;
    }
    return fromOpenAIResponse(response);
  };
}
