import type { BuiltinAdapter, TokenizerFamily } from "@meridian-flow/runtime/gateway";
import { z } from "zod";
import modelDataJson from "./model-data.json" with { type: "json" };

/** Where a Flow-held fact came from and when someone last read it there. The refresh report flags one older than 90 days. */
const provenance = {
  source: z.string().url(),
  checked: z.iso.date(),
  /** Why the value is what it is, for a reader who opens the source and finds something else. */
  note: z.string().optional(),
};

function fact<T extends z.ZodType>(value: T) {
  return z.strictObject({ value, ...provenance });
}

const price = z.strictObject({
  /** USD per million tokens. */
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});

const lifetime = z.number().int().positive().nullable();

const promptCache = z.strictObject({
  kind: z.enum(["explicit", "automatic"]),
  /** Seconds the cache lives for a short request; null when the provider documents none. */
  shortTtlSeconds: lifetime,
  longTtlSeconds: lifetime,
});

/**
 * What models.dev lacks or Flow decides about a model, each fact with its source. An exact model id
 * beats the provider's `"*"` row, fact by fact.
 */
const modelFacts = z.strictObject({
  /** Who made the model, whoever serves it. Absent: the models.dev provider the row comes from. */
  maker: fact(z.string()).optional(),
  tokenizer: fact(
    z.enum(["anthropic", "o200k", "gemini", "deepseek"] satisfies TokenizerFamily[]),
  ).optional(),
  promptCache: fact(promptCache).optional(),
  /** The long-TTL cache-write rate (Anthropic 1h, OpenAI 12h) as a multiple of the input price; models.dev lists only the short-TTL write price. */
  longCacheWrite: fact(z.strictObject({ multiplier: z.number().positive() })).optional(),
  /** The model thinks unless told not to; models.dev does not say. */
  thinksByDefault: fact(z.literal(true)).optional(),
  /** Largest file, in bytes, the provider fetches by link, where its docs state one. */
  maxLinkBytes: fact(z.number().int().positive()).optional(),
  /** Anthropic-format hosts that need Anthropic's tool-schema projection. */
  projectToolSchema: fact(z.literal(true)).optional(),
  /**
   * What Flow charges where models.dev lists another: a rate models.dev has not updated yet, or
   * one that is not the rate Flow pays. It replaces every rate models.dev lists for the model, and
   * is not for a model with context tiers. See `priceOverrideGaps` in `registry.ts` for what the
   * registry refuses.
   */
  price: fact(price).optional(),
});

const providerData = z.strictObject({
  /** API wire format, mapping to ProviderConfig.adapter. */
  adapter: z.enum(["anthropic", "openai", "gemini"] satisfies BuiltinAdapter[]),
  /** Environment variable that must contain a real key for this provider to enable. */
  apiKeyEnv: z.string(),
  baseUrl: z.string().url().optional(),
  /** The provider's key in models.dev's api.json, where it differs from Flow's provider id. */
  modelsDev: z.string().optional(),
  models: z.record(z.string(), modelFacts),
});

const modelData = z.strictObject({
  /** Used when callers omit a model; the registry fails to build when the snapshot lacks it. */
  defaultModel: z.string(),
  /** The rolling summarizer's model unless `COMPACTION_SUMMARIZER_MODEL` names another. */
  compactionSummarizerModel: z.string(),
  providers: z.record(z.string(), providerData),
});

export type ModelFacts = z.infer<typeof modelFacts>;
export type ProviderData = z.infer<typeof providerData> & { id: string };
export type PriceOverride = z.infer<typeof price>;
export type Provenance = { source: string; checked: string; note?: string };

const parsed = modelData.parse(modelDataJson);

export const DEFAULT_MODEL_ID = parsed.defaultModel;
export const COMPACTION_SUMMARIZER_MODEL_ID = parsed.compactionSummarizerModel;
export const PROVIDERS: readonly ProviderData[] = Object.entries(parsed.providers).map(
  ([id, provider]) => ({ id, ...provider }),
);

/** One model's facts: its own, over the provider's `"*"` row. */
export function factsOf(provider: ProviderData, modelId: string): ModelFacts {
  return { ...provider.models["*"], ...provider.models[modelId] };
}
