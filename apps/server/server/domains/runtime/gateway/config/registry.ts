/**
 * Model/provider registry: static source of truth for provider endpoints, wire
 * formats, model metadata, default model, and pinned launch pricing.
 * Key decisions: JSON-natural registry data, provider enablement from each
 * provider's apiKeyEnv. A provider lists offerings: a model plus what that
 * provider charges for it and how it caches it, since the same model can cache
 * and bill differently per provider. Adapter-specific wire checks (cache lifetimes) live in
 * the adapters (`assertModelsOnWire`) and run over every row when a gateway is created from env.
 */
import type {
  BuiltinAdapter,
  Capability,
  GatewayConfig,
  ModelInfo,
  PromptCacheDescriptor,
  ProviderConfig,
  ReasoningSupport,
  TokenizerFamily,
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

/** A model's pinned price tagged with the provider and model it applies to. */
export type ModelTokenRate = ModelPricing & { provider: string; model: string };

export interface RegisteredModel {
  id: string;
  tokenizer: TokenizerFamily;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** JSON-natural capability list; converted to Set only at the gateway boundary. */
  capabilities: readonly Capability[];
  reasoning: ReasoningSupport;
}

/** A model as one provider serves it: the price and cache behavior belong to the provider. */
export interface RegisteredOffering {
  model: RegisteredModel;
  pricing: ModelPricing;
  /** Omitted means `DEFAULT_PROMPT_CACHE`. */
  promptCache?: PromptCacheDescriptor;
}

export interface RegisteredProvider {
  id: string;
  /** API wire format — maps to ProviderConfig.adapter at build time. */
  adapter: BuiltinAdapter;
  /** Environment variable that must contain a real key for this provider to enable. */
  apiKeyEnv: string;
  baseUrl?: string;
  offerings: readonly RegisteredOffering[];
}

export interface ModelRegistry {
  providers: readonly RegisteredProvider[];
  /** Model ID used when callers omit a model. Must exist in at least one provider entry. */
  defaultModel: string;
}

const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing (pinned 2026-11-05)";
const ANTHROPIC_PRICING_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing (pinned 2026-11-05)";
const DEEPSEEK_PRICING_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing (peak fallback pinned 2026-11-05)";
// Pinned at the standard rates. Google's intro rates ($2 in, $0.10 cached, $10 out) end on
// 2026-11-30, and the registry has no effective dates, so billing from 2026-12-01 is correct
// and billing before then slightly over-charges.
const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing (pinned 2026-11-05)";

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const TWELVE_HOURS_MS = 12 * ONE_HOUR_MS;

// An offering with no `promptCache` takes this: explicit breakpoints, 5 minutes for subagents
// and 1 hour for primary chats (Anthropic's two lifetimes).
const DEFAULT_PROMPT_CACHE: PromptCacheDescriptor = {
  kind: "explicit",
  shortTtlMs: FIVE_MINUTES_MS,
  longTtlMs: ONE_HOUR_MS,
};
// GPT-5.6+ caches automatically: `prompt_cache_options.ttl` is "30m" (default) or "12h". A long
// request takes the shortest option of at least 1 hour, which is 12h.
const OPENAI_PROMPT_CACHE: PromptCacheDescriptor = {
  kind: "automatic",
  shortTtlMs: THIRTY_MINUTES_MS,
  longTtlMs: TWELVE_HOURS_MS,
};
// DeepSeek documents the cache as cleared "usually within a few hours to a few days". One hour
// is the lower bound of that and an estimate; Flow sends no cache_control and has no lifetime
// choice, so both chat kinds get it.
const DEEPSEEK_PROMPT_CACHE: PromptCacheDescriptor = {
  kind: "automatic",
  shortTtlMs: ONE_HOUR_MS,
  longTtlMs: ONE_HOUR_MS,
};
// The Gemini API documents no lifetime for implicit caching, so prediction reads it as cold.
const GEMINI_PROMPT_CACHE: PromptCacheDescriptor = {
  kind: "automatic",
  shortTtlMs: null,
  longTtlMs: null,
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

// Reasoning rows are copied from models.dev `reasoning_options`, minus `xhigh`, which Flow never
// requests. `canDisable` is a `toggle` option or a `none` effort.
//
// Claude's Messages API takes `output_config.effort`. Opus 5.5, Sonnet 5.5 and Fable 5.1 have no
// toggle and think adaptively, and `thinking: disabled` or a `budget_tokens` is a 400 on them, so
// Flow sends neither: no registered model needs a budget.
const CLAUDE_REASONING: ReasoningSupport = { efforts: ["low", "medium", "high", "max"] };
// OpenAI lists `none` for GPT-6.1 Terra and GPT-5.6 Luna, not for GPT-6.1 Sol.
const GPT_REASONING: ReasoningSupport = { efforts: ["low", "medium", "high", "max"] };
const GPT_REASONING_CAN_DISABLE: ReasoningSupport = { ...GPT_REASONING, canDisable: true };
const CLAUDE_OPUS_5_5_MODEL = {
  id: "claude-opus-5-5",
  tokenizer: "anthropic",
  displayName: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: ["image_input"],
  reasoning: CLAUDE_REASONING,
} satisfies RegisteredModel;

const CLAUDE_SONNET_5_5_MODEL = {
  id: "claude-sonnet-5-5",
  tokenizer: "anthropic",
  displayName: "Claude Sonnet 5.5",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: ["image_input"],
  reasoning: CLAUDE_REASONING,
} satisfies RegisteredModel;

const CLAUDE_FABLE_5_1_MODEL = {
  id: "claude-fable-5-1",
  tokenizer: "anthropic",
  displayName: "Claude Fable 5.1",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: ["image_input"],
  reasoning: CLAUDE_REASONING,
} satisfies RegisteredModel;

// OpenAI has not published the GPT-6 / GPT-5.6 tokenizer; o200k is the estimate.
const GPT_6_1_SOL_MODEL = {
  id: "gpt-6.1-sol",
  tokenizer: "o200k",
  displayName: "GPT-6.1 Sol",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  capabilities: ["image_input"],
  reasoning: GPT_REASONING,
} satisfies RegisteredModel;

const GPT_6_1_TERRA_MODEL = {
  id: "gpt-6.1-terra",
  tokenizer: "o200k",
  displayName: "GPT-6.1 Terra",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  capabilities: ["image_input"],
  reasoning: GPT_REASONING_CAN_DISABLE,
} satisfies RegisteredModel;

const GPT_5_6_LUNA_MODEL = {
  id: "gpt-5.6-luna",
  tokenizer: "o200k",
  displayName: "GPT-5.6 Luna",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  capabilities: ["image_input"],
  reasoning: GPT_REASONING_CAN_DISABLE,
} satisfies RegisteredModel;

const DEEPSEEK_FLASH_MODEL = {
  id: "deepseek-flash",
  tokenizer: "deepseek",
  displayName: "DeepSeek V4.1 Flash",
  contextWindow: 1_048_576,
  maxOutputTokens: 393_216,
  capabilities: ["image_input"],
  // models.dev: a thinking toggle, and low/high/max (no medium).
  reasoning: { efforts: ["low", "high", "max"], canDisable: true },
} satisfies RegisteredModel;

const GEMINI_4_ARGON_MODEL = {
  id: "gemini-4-argon",
  tokenizer: "gemini",
  displayName: "Gemini 4 Argon",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  // Google's OpenAI endpoint maps `reasoning_effort` to `thinking_level`.
  reasoning: { efforts: ["low", "medium", "high"] },
  capabilities: ["image_input"],
} satisfies RegisteredModel;

export const MODEL_REGISTRY: ModelRegistry = {
  defaultModel: "deepseek-flash",
  providers: [
    {
      id: "anthropic",
      adapter: "anthropic",
      apiKeyEnv: "FLOW_ANTHROPIC_API_KEY",
      offerings: [
        { model: CLAUDE_OPUS_5_5_MODEL, pricing: CLAUDE_OPUS_5_5_PRICING },
        { model: CLAUDE_SONNET_5_5_MODEL, pricing: CLAUDE_SONNET_5_5_PRICING },
        { model: CLAUDE_FABLE_5_1_MODEL, pricing: CLAUDE_FABLE_5_1_PRICING },
      ],
    },
    {
      id: "openai",
      adapter: "openai",
      apiKeyEnv: "FLOW_OPENAI_API_KEY",
      offerings: [
        {
          model: GPT_6_1_SOL_MODEL,
          pricing: GPT_6_1_SOL_PRICING,
          promptCache: OPENAI_PROMPT_CACHE,
        },
        {
          model: GPT_6_1_TERRA_MODEL,
          pricing: GPT_6_1_TERRA_PRICING,
          promptCache: OPENAI_PROMPT_CACHE,
        },
        {
          model: GPT_5_6_LUNA_MODEL,
          pricing: GPT_5_6_LUNA_PRICING,
          promptCache: OPENAI_PROMPT_CACHE,
        },
      ],
    },
    {
      id: "deepseek",
      adapter: "anthropic",
      apiKeyEnv: "FLOW_DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com/anthropic",
      offerings: [
        {
          model: DEEPSEEK_FLASH_MODEL,
          pricing: DEEPSEEK_FLASH_PRICING,
          promptCache: DEEPSEEK_PROMPT_CACHE,
        },
      ],
    },
    {
      id: "gemini",
      adapter: "openai-compatible",
      apiKeyEnv: "FLOW_GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      offerings: [
        {
          model: GEMINI_4_ARGON_MODEL,
          pricing: GEMINI_4_ARGON_PRICING,
          promptCache: GEMINI_PROMPT_CACHE,
        },
      ],
    },
  ],
};

/** Adapter-neutral registry checks, run as soon as a registry is loaded. */
export function validateModelRegistry(registry: ModelRegistry): void {
  for (const { model, pricing, promptCache = DEFAULT_PROMPT_CACHE } of registry.providers.flatMap(
    (provider) => provider.offerings,
  )) {
    const tier = pricing.inputTierTokens;
    if (
      tier !== undefined &&
      (!Number.isFinite(tier) || tier <= 0 || tier >= model.contextWindow)
    ) {
      throw new Error(
        `Input pricing tier for ${model.id} must be positive and below its context window`,
      );
    }
    const { shortTtlMs, longTtlMs } = promptCache;
    if ((shortTtlMs === null) !== (longTtlMs === null)) {
      throw new Error(`Prompt cache lifetimes for ${model.id} must both be set or both be null`);
    }
    if (shortTtlMs !== null && longTtlMs !== null) {
      if (longTtlMs < shortTtlMs) {
        throw new Error(
          `Long prompt cache TTL for ${model.id} must not be shorter than its short TTL`,
        );
      }
      if (
        longTtlMs !== shortTtlMs &&
        pricing.cacheWriteUsdPerMillionTokens !== undefined &&
        pricing.cacheWriteLongUsdPerMillionTokens === undefined
      ) {
        throw new Error(
          `${model.id} has two cache lifetimes and a cache-write price but no long cache-write price`,
        );
      }
    }
  }
}

validateModelRegistry(MODEL_REGISTRY);

/** Keys starting with "dev-" are mock/placeholder and do not enable live providers. */
export function hasRealApiKey(key: string | undefined): boolean {
  return Boolean(key && key.length > 0 && !key.startsWith("dev-"));
}

function toModelInfo(
  provider: RegisteredProvider,
  { model, pricing, promptCache = DEFAULT_PROMPT_CACHE }: RegisteredOffering,
): ModelInfo {
  return {
    id: model.id,
    provider: provider.id,
    displayName: model.displayName,
    tokenizer: model.tokenizer,
    contextWindow: model.contextWindow,
    inputTierTokens: pricing.inputTierTokens,
    maxOutputTokens: model.maxOutputTokens,
    promptCache,
    reasoning: model.reasoning,
    capabilities: new Set(model.capabilities),
  };
}

function toProviderConfig(entry: RegisteredProvider): ProviderConfig {
  return {
    id: entry.id,
    adapter: entry.adapter,
    baseUrl: entry.baseUrl,
    models: entry.offerings.map((offering) => toModelInfo(entry, offering)),
  };
}

/** Every registry provider as a keyless config, for checks that must not depend on which keys are set. */
export function registryProviderConfigs(registry: ModelRegistry): ProviderConfig[] {
  return registry.providers.map(toProviderConfig);
}

export function buildFromRegistry(
  registry: ModelRegistry,
  env: Readonly<Record<string, string | number | undefined>>,
): Pick<GatewayConfig, "providers" | "defaultModel"> {
  validateModelRegistry(registry);
  const providers: ProviderConfig[] = [];

  for (const entry of registry.providers) {
    const apiKey = env[entry.apiKeyEnv];
    if (typeof apiKey !== "string" || !hasRealApiKey(apiKey)) continue;
    providers.push({ ...toProviderConfig(entry), auth: { apiKey } });
  }

  const enabledModelIds = new Set(
    providers.flatMap((provider) => provider.models.map((model) => model.id)),
  );
  // When the registry default is not enabled, defaultGatewayOptions falls back to the first model.
  const defaultModel = enabledModelIds.has(registry.defaultModel)
    ? registry.defaultModel
    : undefined;

  return { providers, defaultModel };
}

/** Pinned rate rows, shaped for billing's `ModelTokenRate`. */
export function extractPinnedRates(registry: ModelRegistry): ModelTokenRate[] {
  return registry.providers.flatMap((provider) =>
    provider.offerings.map(({ model, pricing }) => ({
      provider: provider.id,
      model: model.id,
      ...pricing,
    })),
  );
}
