import { z } from "zod";

export const UsageBreakdown = z.record(z.string(), z.number().finite());
export type UsageBreakdown = z.infer<typeof UsageBreakdown>;

export const AnthropicUsageBreakdown = z.object({
  cache_read: z.number().finite().optional(),
  cache_write: z.number().finite().optional(),
  web_searches: z.number().finite().optional(),
  web_search_cost_usd: z.number().finite().optional(),
});
export type AnthropicUsageBreakdown = z.infer<typeof AnthropicUsageBreakdown>;

export const OpenAIUsageBreakdown = z.object({
  cached: z.number().finite().optional(),
  reasoning: z.number().finite().optional(),
});
export type OpenAIUsageBreakdown = z.infer<typeof OpenAIUsageBreakdown>;
