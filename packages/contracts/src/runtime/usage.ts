/**
 * Purpose: Defines the JSON-natural token usage contract shared by the model
 * gateway, runtime metering, and billing price conversion.
 * Key decision: provider adapters normalize their native token accounting into
 * this plain DTO before any runtime or billing logic consumes it.
 */

/**
 * Normalized token usage across providers.
 *
 * Provider mapping:
 * - Anthropic: `usage.input_tokens` / `usage.output_tokens`, cache fields from
 *   `cache_read_input_tokens` / `cache_creation_input_tokens`, reasoning from
 *   `output_tokens_details.thinking_tokens`.
 * - OpenAI Responses: `usage.input_tokens` / `usage.output_tokens`, cache from
 *   `input_tokens_details.cached_tokens`, reasoning from
 *   `output_tokens_details.reasoning_tokens`.
 * - OpenAI-Chat-Compatible: `usage.prompt_tokens` / `usage.completion_tokens`,
 *   reasoning from `completion_tokens_details.reasoning_tokens`.
 *
 * Optional fields: only set when the provider reports a positive (>0) value.
 * Billing ignores Usage for provider-reported cost — OpenRouter carries
 * `reportedCostUsd` on GenerateResult.providerData instead.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
