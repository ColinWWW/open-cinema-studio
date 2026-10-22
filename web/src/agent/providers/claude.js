// Claude through the official Anthropic SDK. The loop already speaks the Messages API, so this only adds the
// model settings and turns SDK errors into readable messages.

export const CLAUDE_MODEL = 'claude-opus-5-5';

/** A readable message for a Claude API failure, from the SDK's typed errors. */
export function claudeErrorMessage(Anthropic, err) {
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
export function claudeProvider({ apiKey, baseURL, model = CLAUDE_MODEL, effort = 'high' } = {}) {
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
      const message = claudeErrorMessage(Anthropic, err);
      throw message ? new Error(message, { cause: err }) : err;
    }
  };
}
