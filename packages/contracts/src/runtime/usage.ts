/**
 * Purpose: Defines the JSON-natural token usage contract shared by the model
 * gateway, runtime metering, and billing price conversion.
 * Key decision: provider adapters normalize their native token accounting into
 * this plain DTO before any runtime or billing logic consumes it.
 */

/**
 * Normalized token usage across providers.
 *
 * `inputTokens` is the inclusive input total. `cacheReadTokens` and
 * `cacheWriteTokens` are disjoint subsets of that total, so their sum must not
 * exceed `inputTokens`. This shape keeps persisted totals and token displays
 * comparable across providers and lets provider-agnostic pricing derive the
 * uncached remainder. Adapters for providers such as Anthropic, which reports
 * uncached input and cache counters as separate additive categories, must sum
 * those categories at the gateway boundary.
 *
 * Provider mapping:
 * - Anthropic: inclusive input is `input_tokens` +
 *   `cache_read_input_tokens` + `cache_creation_input_tokens`; output and
 *   reasoning come from `output_tokens` and
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

/** Throws when a Usage value violates the canonical inclusive-total contract. */
export function assertValidUsage(usage: Usage): void {
  const counts = [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
    ["reasoningTokens", usage.reasoningTokens],
    ["cacheReadTokens", usage.cacheReadTokens],
    ["cacheWriteTokens", usage.cacheWriteTokens],
  ] as const;

  for (const [field, count] of counts) {
    if (count !== undefined && (!Number.isInteger(count) || count < 0)) {
      throw new Error(`Usage.${field} must be a non-negative integer; got ${count}`);
    }
  }

  const cacheTokens = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (cacheTokens > usage.inputTokens) {
    throw new Error(
      "Usage invariant violated: cacheReadTokens + cacheWriteTokens must not exceed inputTokens",
    );
  }
}
