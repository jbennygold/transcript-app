import Anthropic from '@anthropic-ai/sdk';

export interface LLMErrorInfo {
  /** Human-readable, user-safe message describing the failure. */
  message: string;
  /** Upstream HTTP status, when the failure came from the Anthropic API. */
  status?: number;
}

/**
 * Extract a user-safe, human-readable message from an error thrown by an
 * Anthropic API call. The SDK's APIError stores the raw message as
 * `"<status> <json body>"`, which is noisy; the clean provider message lives at
 * `err.error.error.message` (e.g. "Your credit balance is too low..."). We
 * surface that so operators see the real cause instead of a generic string.
 */
export function describeLLMError(err: unknown): LLMErrorInfo {
  if (err instanceof Anthropic.APIError) {
    const nested = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return { message: nested || err.message, status: err.status };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}
