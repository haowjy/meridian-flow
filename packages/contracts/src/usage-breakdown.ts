/**
 * Provider-specific billable usage stored on model_responses.usage_breakdown (flat JSONB).
 * Provider identity lives on model_responses.provider — not inside this object.
 * @see database-schema-v3.md §9
 */

/** Extensible map for future providers; values are token counts or USD amounts. */
export type UsageBreakdown = Record<string, number>;

/** Anthropic billable dimensions */
export interface AnthropicUsageBreakdown {
  cache_read?: number;
  cache_write?: number;
  web_searches?: number;
  web_search_cost_usd?: number;
}

/** OpenAI billable dimensions */
export interface OpenAIUsageBreakdown {
  cached?: number;
  reasoning?: number;
}

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
