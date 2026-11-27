import type { BuiltinAdapter, TokenizerFamily } from "@meridian-flow/runtime/gateway";
import { z } from "zod";
import modelDataJson from "./model-data.json" with { type: "json" };

const provenance = {
  source: z.string().url(),
  checked: z.iso.date(),
  note: z.string().optional(),
};

function fact<T extends z.ZodType>(value: T) {
  return z.strictObject({ value, ...provenance });
}

const price = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});

const lifetime = z.number().int().positive().nullable();

const promptCache = z.strictObject({
  kind: z.enum(["explicit", "automatic"]),
  shortTtlSeconds: lifetime,
  longTtlSeconds: lifetime,
});

const modelFacts = z.strictObject({
  maker: fact(z.string()).optional(),
  tokenizer: fact(
    z.enum(["anthropic", "o200k", "gemini", "deepseek"] satisfies TokenizerFamily[]),
  ).optional(),
  promptCache: fact(promptCache).optional(),
  longCacheWrite: fact(z.strictObject({ multiplier: z.number().positive() })).optional(),
  thinksByDefault: fact(z.literal(true)).optional(),
  maxLinkBytes: fact(z.number().int().positive()).optional(),
  functionCallIds: fact(z.literal(true)).optional(),
  projectToolSchema: fact(z.literal(true)).optional(),
  price: fact(price).optional(),
});

const providerData = z.strictObject({
  adapter: z.enum(["anthropic", "openai", "gemini"] satisfies BuiltinAdapter[]),
  apiKeyEnv: z.string(),
  baseUrl: z.string().url().optional(),
  testOnly: z.literal(true).optional(),
  modelsDev: z.string().optional(),
  models: z.record(z.string(), modelFacts),
});

const modelData = z.strictObject({
  defaultModel: z.string(),
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

export function factsOf(provider: ProviderData, modelId: string): ModelFacts {
  return { ...provider.models["*"], ...provider.models[modelId] };
}
