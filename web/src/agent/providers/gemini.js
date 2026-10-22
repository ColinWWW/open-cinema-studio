// Gemini through the official @google/genai SDK, adapted to the loop's Messages API shapes. Each model turn
// is kept as Gemini returned it (a `provider_state` block) and replayed unchanged, so its thought
// signatures survive from one round to the next. view_shot images go back inside the function response.

export const GEMINI_MODEL = 'gemini-pro-latest';

const REFUSED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

const textOf = (content) => (typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
const parsed = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { output: v };
  } catch {
    return { output: text };
  }
};

/** The loop's history as Gemini contents. */
export function toGeminiContents(messages) {
  const calls = new Map(); // tool_use id -> {name, geminiId}
  return messages.map((m) => {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') calls.set(b.id, { name: b.name, geminiId: b.provider_id });
      const kept = m.content.find((b) => b.type === 'provider_state' && b.provider === 'gemini');
      if (kept) return kept.data;
      return {
        role: 'model',
        parts: m.content.flatMap((b) => (b.type === 'text' ? [{ text: b.text }] : b.type === 'tool_use' ? [{ functionCall: { name: b.name, args: b.input } }] : [])),
      };
    }
    if (typeof m.content === 'string') return { role: 'user', parts: [{ text: m.content }] };
    return {
      role: 'user',
      parts: m.content.map((r) => {
        if (r.type === 'text') return { text: r.text };
        const call = calls.get(r.tool_use_id) ?? { name: 'unknown' };
        const text = textOf(r.content);
        const images = Array.isArray(r.content) ? r.content.filter((c) => c.type === 'image') : [];
        return {
          functionResponse: {
            ...(call.geminiId ? { id: call.geminiId } : {}),
            name: call.name,
            response: r.is_error ? { error: text } : parsed(text),
            ...(images.length ? { parts: images.map((c) => ({ inlineData: { mimeType: c.source.media_type, data: c.source.data } })) } : {}),
          },
        };
      }),
    };
  });
}

/** A Gemini response in the loop's shape: {stop_reason, content, stop_details?}. */
export function fromGeminiResponse(response, turn = 0) {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) return { stop_reason: 'refusal', stop_details: { explanation: `Gemini blocked the request (${blocked})` }, content: [] };
  const candidate = response.candidates?.[0];
  const data = candidate?.content ?? { role: 'model', parts: [] };
  const parts = data.parts ?? [];
  const content = [{ type: 'provider_state', provider: 'gemini', data }];
  let n = 0;
  for (const p of parts) {
    if (p.text && !p.thought) content.push({ type: 'text', text: p.text });
    if (p.functionCall) {
      content.push({ type: 'tool_use', id: p.functionCall.id || `gemini_${turn}_${n}`, provider_id: p.functionCall.id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
      n++;
    }
  }
  const reason = candidate?.finishReason;
  if (n) return { stop_reason: 'tool_use', content };
  if (REFUSED.has(reason)) return { stop_reason: 'refusal', stop_details: { explanation: `Gemini stopped for ${reason.toLowerCase().replace(/_/g, ' ')}` }, content };
  if (reason === 'MAX_TOKENS') return { stop_reason: 'max_tokens', content };
  if (reason === 'MALFORMED_FUNCTION_CALL') throw new Error('Gemini made a tool call it couldn’t finish. Try again, or try another model.');
  return { stop_reason: 'end_turn', content };
}

/** Tool definitions for Gemini: the same JSON Schemas. */
export const toGeminiTools = (tools) => [
  { functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) },
];

/** A readable message for a Gemini API failure. */
export function geminiErrorMessage(genai, err) {
  if (err?.name === 'AbortError') return 'Stopped.';
  if (err instanceof genai.ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) return 'The Gemini API rejected the API key.';
    if (err.status === 401 || err.status === 403) return 'The Gemini API rejected the API key, or it can’t use this model.';
    if (err.status === 404) return 'The Gemini API doesn’t know that model.';
    if (err.status === 429) return 'Rate limited by the Gemini API: wait a moment and try again.';
    return `Gemini API error ${err.status}: ${err.message}`;
  }
  if (err instanceof TypeError) return 'Couldn’t reach the Gemini API (offline, or the “via” URL is wrong).';
  return null;
}

/** A createMessage for the Gemini API. The SDK loads on the first call. */
export function geminiProvider({ apiKey, baseURL, model = GEMINI_MODEL } = {}) {
  let sdk = null;
  let turn = 0;
  return async (params, { signal } = {}) => {
    sdk ??= import('@google/genai').then((genai) => ({
      genai,
      client: new genai.GoogleGenAI({ apiKey, ...(baseURL ? { httpOptions: { baseUrl: baseURL } } : {}) }),
    }));
    const { genai, client } = await sdk;
    let response;
    try {
      response = await client.models.generateContent({
        model,
        contents: toGeminiContents(params.messages),
        config: {
          systemInstruction: params.system,
          tools: toGeminiTools(params.tools),
          maxOutputTokens: 16000,
          thinkingConfig: { thinkingLevel: genai.ThinkingLevel.HIGH },
          abortSignal: signal,
        },
      });
    } catch (err) {
      const message = geminiErrorMessage(genai, err);
      throw message ? new Error(message, { cause: err }) : err;
    }
    return fromGeminiResponse(response, turn++);
  };
}
