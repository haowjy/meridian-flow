import { z } from "zod";

/**
 * Provider-specific billable usage stored on model_responses.usage_breakdown (flat JSONB).
 * Provider identity lives on model_responses.provider — not inside this object.
 * @see database-schema-v3.md §9
 */

/** Extensible map for future providers; values are token counts or USD amounts. */
export const UsageBreakdown = z.record(z.string(), z.number().finite());
export type UsageBreakdown = z.infer<typeof UsageBreakdown>;

/** Anthropic billable dimensions */
export const AnthropicUsageBreakdown = z.object({
  cache_read: z.number().finite().optional(),
  cache_write: z.number().finite().optional(),
  web_searches: z.number().finite().optional(),
  web_search_cost_usd: z.number().finite().optional(),
});
export type AnthropicUsageBreakdown = z.infer<typeof AnthropicUsageBreakdown>;

/** OpenAI billable dimensions */
export const OpenAIUsageBreakdown = z.object({
  cached: z.number().finite().optional(),
  reasoning: z.number().finite().optional(),
});
export type OpenAIUsageBreakdown = z.infer<typeof OpenAIUsageBreakdown>;

export function parseUsageBreakdown(_provider: string, raw: unknown): UsageBreakdown {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: UsageBreakdown = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}
