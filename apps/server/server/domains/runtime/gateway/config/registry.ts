/**
 * Model/provider registry: static source of truth for provider endpoints, wire
 * formats, model metadata, default model, and pinned launch pricing.
 * Key decisions: JSON-natural registry data, provider enablement from each
 * provider's apiKeyEnv, and gateway-local PinnedModelRate (G4 — billing consumes
 * structurally in B2, no billing import here).
 */
import {
  type BuiltinAdapter,
  type Capability,
  type GatewayConfig,
  type ModelInfo,
  openaiCacheTtlWire,
  type PromptCacheDescriptor,
  type ProviderConfig,
  type ReasoningEffort,
  type TokenizerFamily,
} from "../domain/index.js";

export interface ModelPricing {
  /** Input size above which the provider reprices the whole request. */
  inputTierTokens?: number;
  /** Whole-request multipliers above `inputTierTokens`: `input` scales every input-side rate, `output` the output rate. */
  aboveTierMultipliers?: { input: number; output: number };
  /** USD per 1,000,000 uncached input tokens. */
  inputUsdPerMillionTokens: string;
  /** USD per 1,000,000 output tokens. */
  outputUsdPerMillionTokens: string;
  /** USD per 1,000,000 cache-read input tokens, when published separately. */
  cachedInputUsdPerMillionTokens?: string;
  /** USD per 1,000,000 cache-write input tokens, when published separately (the short-TTL rate when a long-TTL rate is also set). */
  cacheWriteUsdPerMillionTokens?: string;
  /** USD per 1,000,000 long-TTL cache-write tokens (Anthropic 1h, OpenAI 12h), for providers that bill writes by TTL. */
  cacheWriteLongUsdPerMillionTokens?: string;
  /** Human-readable attribution for the pinned price. */
  source: string;
}

export interface RegisteredModel {
  id: string;
  tokenizer: TokenizerFamily;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** JSON-natural capability list; converted to Set only at the gateway boundary. */
  capabilities: readonly Capability[];
  promptCache: PromptCacheDescriptor;
  /** Highest effort level the model accepts; absent means `max`. */
  maxReasoningEffort?: ReasoningEffort;
  pricing: ModelPricing;
}

export interface RegisteredProvider {
  id: string;
  /** API wire format — maps to ProviderConfig.adapter at build time. */
  adapter: BuiltinAdapter | string;
  /** Environment variable that must contain a real key for this provider to enable. */
  apiKeyEnv: string;
  baseUrl?: string;
  models: readonly RegisteredModel[];
}

export interface ModelRegistry {
  providers: readonly RegisteredProvider[];
  /** Model ID used when callers omit a model. Must exist in at least one provider entry. */
  defaultModel: string;
}

/**
 * Gateway-local pinned rate row. Structurally matches billing's ModelTokenRate so
 * B2 can wire extractPinnedRates → createLayeredTokenRateSource without a
 * gateway→billing type dependency (G4).
 */
export interface PinnedModelRate {
  provider: string;
  model: string;
  inputUsdPerMillionTokens: string;
  cachedInputUsdPerMillionTokens?: string;
  cacheWriteUsdPerMillionTokens?: string;
  cacheWriteLongUsdPerMillionTokens?: string;
  outputUsdPerMillionTokens: string;
  inputTierTokens?: number;
  aboveTierMultipliers?: { input: number; output: number };
  source: string;
}

const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing (pinned 2026-10-29)";
const ANTHROPIC_PRICING_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing (pinned 2026-10-29)";
const DEEPSEEK_PRICING_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing (peak fallback pinned 2026-10-29)";
// Pinned at the standard rates. Google's intro rates ($2 in, $0.10 cached, $10 out) end on
// 2026-11-30, and the registry has no effective dates, so billing from 2026-12-01 is correct
// and billing before then slightly over-charges.
const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing (pinned 2026-10-29)";

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const TWELVE_HOURS_MS = 12 * ONE_HOUR_MS;

const EXPLICIT_CACHE_5M_OR_1H: PromptCacheDescriptor = {
  kind: "explicit",
  ttlMs: FIVE_MINUTES_MS,
  longTtlMs: ONE_HOUR_MS,
};
// GPT-5.6+ caches automatically: `prompt_cache_options.ttl` is "30m" (default) or "12h". A long
// request takes the shortest option of at least 1 hour, which is 12h.
const OPENAI_CACHE_30M_OR_12H: PromptCacheDescriptor = {
  kind: "automatic",
  ttlMs: THIRTY_MINUTES_MS,
  longTtlMs: TWELVE_HOURS_MS,
};
// DeepSeek and Gemini cache automatically and expose no lifetime choice (we send no
// cache_control; DeepSeek's Anthropic-compatible endpoint ignores it), and neither documents
// a lifetime, so 5 minutes is an assumed minimum for both chat kinds.
const AUTOMATIC_CACHE_ESTIMATE: PromptCacheDescriptor = {
  kind: "automatic",
  ttlMs: FIVE_MINUTES_MS,
};

// Claude bills cache writes by the TTL written: 5m at 1.25x input, 1h at 2x. Anthropic's
// usage reports the split, so `cacheWriteUsdPerMillionTokens` is the 5m rate and
// `cacheWriteLongUsdPerMillionTokens` the 1h one.
const CLAUDE_OPUS_5_5_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "4.00",
  cachedInputUsdPerMillionTokens: "0.20",
  cacheWriteUsdPerMillionTokens: "5.00",
  cacheWriteLongUsdPerMillionTokens: "8.00",
  outputUsdPerMillionTokens: "20.00",
  source: ANTHROPIC_PRICING_SOURCE,
};

const CLAUDE_SONNET_5_5_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "2.00",
  cachedInputUsdPerMillionTokens: "0.10",
  cacheWriteUsdPerMillionTokens: "2.50",
  cacheWriteLongUsdPerMillionTokens: "4.00",
  outputUsdPerMillionTokens: "10.00",
  source: ANTHROPIC_PRICING_SOURCE,
};

const CLAUDE_FABLE_5_1_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "10.00",
  cachedInputUsdPerMillionTokens: "0.25",
  cacheWriteUsdPerMillionTokens: "12.50",
  cacheWriteLongUsdPerMillionTokens: "20.00",
  outputUsdPerMillionTokens: "50.00",
  source: ANTHROPIC_PRICING_SOURCE,
};

// OpenAI bills cache writes by TTL too: 30m at 1.25x input, 12h at 2.5x. Above 272K input
// tokens the whole request is billed at 2x input and cache rates and 1.5x output; the same
// threshold drives compaction planning.
const OPENAI_LONG_CONTEXT = {
  inputTierTokens: 272_000,
  aboveTierMultipliers: { input: 2, output: 1.5 },
};

const GPT_6_1_SOL_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "2.00",
  cachedInputUsdPerMillionTokens: "0.10",
  cacheWriteUsdPerMillionTokens: "2.50",
  cacheWriteLongUsdPerMillionTokens: "5.00",
  outputUsdPerMillionTokens: "10.00",
  ...OPENAI_LONG_CONTEXT,
  source: OPENAI_PRICING_SOURCE,
};

const GPT_6_1_TERRA_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "1.00",
  cachedInputUsdPerMillionTokens: "0.05",
  cacheWriteUsdPerMillionTokens: "1.25",
  cacheWriteLongUsdPerMillionTokens: "2.50",
  outputUsdPerMillionTokens: "5.00",
  ...OPENAI_LONG_CONTEXT,
  source: OPENAI_PRICING_SOURCE,
};

const GPT_5_6_LUNA_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "0.20",
  cachedInputUsdPerMillionTokens: "0.02",
  cacheWriteUsdPerMillionTokens: "0.25",
  cacheWriteLongUsdPerMillionTokens: "0.50",
  outputUsdPerMillionTokens: "1.20",
  ...OPENAI_LONG_CONTEXT,
  source: OPENAI_PRICING_SOURCE,
};

// Peak rates; off-peak is half.
const DEEPSEEK_FLASH_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "0.30",
  cachedInputUsdPerMillionTokens: "0.006",
  outputUsdPerMillionTokens: "1.20",
  source: DEEPSEEK_PRICING_SOURCE,
};

// Implicit cache only: no write fee.
const GEMINI_4_ARGON_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "4.00",
  cachedInputUsdPerMillionTokens: "0.20",
  outputUsdPerMillionTokens: "20.00",
  source: GEMINI_PRICING_SOURCE,
};

// Claude's Messages API takes `output_config.effort` (low..max, as models.dev lists for all three
// models). Opus 5.5, Sonnet 5.5 and Fable 5.1 think adaptively, and `thinking: disabled` or a
// `budget_tokens` is a 400 on them, so Flow sends neither: no registered model needs a budget.
const CLAUDE_OPUS_5_5_MODEL = {
  id: "claude-opus-5-5",
  tokenizer: "anthropic",
  displayName: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  promptCache: EXPLICIT_CACHE_5M_OR_1H,
  capabilities: ["image_input"],
  pricing: CLAUDE_OPUS_5_5_PRICING,
} satisfies RegisteredModel;

const CLAUDE_SONNET_5_5_MODEL = {
  id: "claude-sonnet-5-5",
  tokenizer: "anthropic",
  displayName: "Claude Sonnet 5.5",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  promptCache: EXPLICIT_CACHE_5M_OR_1H,
  capabilities: ["image_input"],
  pricing: CLAUDE_SONNET_5_5_PRICING,
} satisfies RegisteredModel;

const CLAUDE_FABLE_5_1_MODEL = {
  id: "claude-fable-5-1",
  tokenizer: "anthropic",
  displayName: "Claude Fable 5.1",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  promptCache: EXPLICIT_CACHE_5M_OR_1H,
  capabilities: ["image_input"],
  pricing: CLAUDE_FABLE_5_1_PRICING,
} satisfies RegisteredModel;

// OpenAI has not published the GPT-6 / GPT-5.6 tokenizer; o200k is the estimate.
const GPT_6_1_SOL_MODEL = {
  id: "gpt-6.1-sol",
  tokenizer: "o200k",
  displayName: "GPT-6.1 Sol",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  promptCache: OPENAI_CACHE_30M_OR_12H,
  capabilities: ["image_input"],
  pricing: GPT_6_1_SOL_PRICING,
} satisfies RegisteredModel;

const GPT_6_1_TERRA_MODEL = {
  id: "gpt-6.1-terra",
  tokenizer: "o200k",
  displayName: "GPT-6.1 Terra",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  promptCache: OPENAI_CACHE_30M_OR_12H,
  capabilities: ["image_input"],
  pricing: GPT_6_1_TERRA_PRICING,
} satisfies RegisteredModel;

const GPT_5_6_LUNA_MODEL = {
  id: "gpt-5.6-luna",
  tokenizer: "o200k",
  displayName: "GPT-5.6 Luna",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  promptCache: OPENAI_CACHE_30M_OR_12H,
  capabilities: ["image_input"],
  pricing: GPT_5_6_LUNA_PRICING,
} satisfies RegisteredModel;

const DEEPSEEK_FLASH_MODEL = {
  id: "deepseek-flash",
  tokenizer: "deepseek",
  displayName: "DeepSeek V4.1 Flash",
  contextWindow: 1_048_576,
  maxOutputTokens: 393_216,
  promptCache: AUTOMATIC_CACHE_ESTIMATE,
  capabilities: ["image_input"],
  pricing: DEEPSEEK_FLASH_PRICING,
} satisfies RegisteredModel;

const GEMINI_4_ARGON_MODEL = {
  id: "gemini-4-argon",
  tokenizer: "gemini",
  displayName: "Gemini 4 Argon",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  promptCache: AUTOMATIC_CACHE_ESTIMATE,
  // Google's OpenAI endpoint maps `reasoning_effort` to `thinking_level`: low, medium, high.
  maxReasoningEffort: "high",
  capabilities: ["image_input"],
  pricing: GEMINI_4_ARGON_PRICING,
} satisfies RegisteredModel;

export const MODEL_REGISTRY: ModelRegistry = {
  defaultModel: "deepseek-flash",
  providers: [
    {
      id: "anthropic",
      adapter: "anthropic",
      apiKeyEnv: "FLOW_ANTHROPIC_API_KEY",
      models: [CLAUDE_OPUS_5_5_MODEL, CLAUDE_SONNET_5_5_MODEL, CLAUDE_FABLE_5_1_MODEL],
    },
    {
      id: "openai",
      adapter: "openai",
      apiKeyEnv: "FLOW_OPENAI_API_KEY",
      models: [GPT_6_1_SOL_MODEL, GPT_6_1_TERRA_MODEL, GPT_5_6_LUNA_MODEL],
    },
    {
      id: "deepseek",
      adapter: "anthropic",
      apiKeyEnv: "FLOW_DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com/anthropic",
      models: [DEEPSEEK_FLASH_MODEL],
    },
    {
      id: "gemini",
      adapter: "openai-compatible",
      apiKeyEnv: "FLOW_GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      models: [GEMINI_4_ARGON_MODEL],
    },
  ],
};

/** Reject cache TTLs the provider cannot be sent, as soon as a registry is loaded. */
export function validateModelRegistry(registry: ModelRegistry): void {
  for (const { adapter, model } of registry.providers.flatMap((provider) =>
    provider.models.map((model) => ({ adapter: provider.adapter, model })),
  )) {
    const tier = model.pricing.inputTierTokens;
    if (
      tier !== undefined &&
      (!Number.isFinite(tier) || tier <= 0 || tier >= model.contextWindow)
    ) {
      throw new Error(
        `Input pricing tier for ${model.id} must be positive and below its context window`,
      );
    }
    const { ttlMs, longTtlMs } = model.promptCache;
    if (longTtlMs !== undefined && (ttlMs === null || longTtlMs <= ttlMs)) {
      throw new Error(`Long prompt cache TTL for ${model.id} must exceed its short TTL`);
    }
    if (adapter === "openai" && longTtlMs !== undefined) {
      if (ttlMs !== THIRTY_MINUTES_MS || openaiCacheTtlWire(longTtlMs) !== "12h") {
        throw new Error(
          `OpenAI prompt cache TTLs for ${model.id} must be 30m, with 12h as the long one`,
        );
      }
    }
    if (adapter === "anthropic" && model.promptCache.kind === "explicit") {
      for (const ttl of [model.promptCache.ttlMs, model.promptCache.longTtlMs ?? FIVE_MINUTES_MS]) {
        if (ttl !== FIVE_MINUTES_MS && ttl !== ONE_HOUR_MS) {
          throw new Error(`Explicit prompt cache TTL for ${model.id} must be 5 minutes or 1 hour`);
        }
      }
    }
  }
}

validateModelRegistry(MODEL_REGISTRY);

/** Keys starting with "dev-" are mock/placeholder and do not enable live providers. */
export function hasRealApiKey(key: string | undefined): boolean {
  return Boolean(key && key.length > 0 && !key.startsWith("dev-"));
}

function toModelInfo(provider: RegisteredProvider, model: RegisteredModel): ModelInfo {
  return {
    id: model.id,
    provider: provider.id,
    displayName: model.displayName,
    tokenizer: model.tokenizer,
    contextWindow: model.contextWindow,
    inputTierTokens: model.pricing.inputTierTokens,
    maxOutputTokens: model.maxOutputTokens,
    promptCache: model.promptCache,
    maxReasoningEffort: model.maxReasoningEffort,
    capabilities: new Set(model.capabilities),
  };
}

export function buildFromRegistry(
  registry: ModelRegistry,
  env: Record<string, string | undefined>,
): Pick<GatewayConfig, "providers" | "defaultModel"> {
  validateModelRegistry(registry);
  const providers: ProviderConfig[] = [];

  for (const entry of registry.providers) {
    const apiKey = env[entry.apiKeyEnv];
    if (!hasRealApiKey(apiKey)) continue;

    providers.push({
      id: entry.id,
      adapter: entry.adapter,
      auth: { apiKey },
      baseUrl: entry.baseUrl,
      models: entry.models.map((model) => toModelInfo(entry, model)),
    });
  }

  const enabledModelIds = new Set(
    providers.flatMap((provider) => provider.models.map((model) => model.id)),
  );
  const defaultModel = enabledModelIds.has(registry.defaultModel)
    ? registry.defaultModel
    : providers[0]?.models[0]?.id;

  return { providers, defaultModel };
}

export function extractPinnedRates(registry: ModelRegistry): PinnedModelRate[] {
  return registry.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      model: model.id,
      inputUsdPerMillionTokens: model.pricing.inputUsdPerMillionTokens,
      cachedInputUsdPerMillionTokens: model.pricing.cachedInputUsdPerMillionTokens,
      cacheWriteUsdPerMillionTokens: model.pricing.cacheWriteUsdPerMillionTokens,
      cacheWriteLongUsdPerMillionTokens: model.pricing.cacheWriteLongUsdPerMillionTokens,
      outputUsdPerMillionTokens: model.pricing.outputUsdPerMillionTokens,
      inputTierTokens: model.pricing.inputTierTokens,
      aboveTierMultipliers: model.pricing.aboveTierMultipliers,
      source: model.pricing.source,
    })),
  );
}
