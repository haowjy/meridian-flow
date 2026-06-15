/**
 * Model/provider registry: static source of truth for provider endpoints, wire
 * formats, model metadata, default model, and pinned launch pricing.
 * Key decisions: JSON-natural registry data, provider enablement from each
 * provider's apiKeyEnv, and gateway-local PinnedModelRate (G4 — billing consumes
 * structurally in B2, no billing import here).
 */
import type {
  BuiltinAdapter,
  Capability,
  GatewayConfig,
  ModelInfo,
  ProviderConfig,
} from "../domain/index.js";

export interface ModelPricing {
  /** USD per 1,000,000 uncached input tokens. */
  inputUsdPerMillionTokens: string;
  /** USD per 1,000,000 output tokens. */
  outputUsdPerMillionTokens: string;
  /** USD per 1,000,000 cache-read input tokens, when published separately. */
  cachedInputUsdPerMillionTokens?: string;
  /** USD per 1,000,000 cache-write input tokens, when published separately. */
  cacheWriteUsdPerMillionTokens?: string;
  /** Human-readable attribution for the pinned price. */
  source: string;
}

export interface RegisteredModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** JSON-natural capability list; converted to Set only at the gateway boundary. */
  capabilities: readonly Capability[];
  /** Provider-side tools that Meridian advertises but does not execute itself. */
  hostedTools?: readonly string[];
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
  outputUsdPerMillionTokens: string;
  source: string;
}

const OPENAI_PRICING_SOURCE = "https://openai.com/api/pricing/ (pinned 2026-06-10)";
const ANTHROPIC_PRICING_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing (pinned 2026-06-10)";
const DEEPSEEK_PRICING_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing (pinned 2026-06-10)";

const CLAUDE_SONNET_4_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "3.00",
  cachedInputUsdPerMillionTokens: "0.30",
  cacheWriteUsdPerMillionTokens: "3.75",
  outputUsdPerMillionTokens: "15.00",
  source: ANTHROPIC_PRICING_SOURCE,
};

const GPT_4O_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "2.50",
  cachedInputUsdPerMillionTokens: "1.25",
  outputUsdPerMillionTokens: "10.00",
  source: OPENAI_PRICING_SOURCE,
};

const DEEPSEEK_FLASH_PRICING: ModelPricing = {
  inputUsdPerMillionTokens: "0.14",
  cachedInputUsdPerMillionTokens: "0.0028",
  outputUsdPerMillionTokens: "0.28",
  source: DEEPSEEK_PRICING_SOURCE,
};

const CLAUDE_SONNET_4_MODEL = {
  id: "claude-sonnet-4-20250514",
  displayName: "Claude Sonnet 4",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  capabilities: [
    "streaming",
    "tool_calling",
    "image_input",
    "structured_output",
    "reasoning",
    "caching",
  ],
  hostedTools: ["web_search", "code_execution", "anthropic.text_editor", "anthropic.computer_use"],
  pricing: CLAUDE_SONNET_4_PRICING,
} satisfies RegisteredModel;

const GPT_4O_MODEL = {
  id: "gpt-4o",
  displayName: "GPT-4o",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  capabilities: [
    "streaming",
    "tool_calling",
    "parallel_tool_calls",
    "image_input",
    "structured_output",
    "reasoning",
  ],
  hostedTools: ["web_search", "code_execution", "file_search"],
  pricing: GPT_4O_PRICING,
} satisfies RegisteredModel;

const DEEPSEEK_V4_FLASH_MODEL = {
  id: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  capabilities: ["streaming", "tool_calling", "structured_output", "reasoning"],
  pricing: DEEPSEEK_FLASH_PRICING,
} satisfies RegisteredModel;

export const MODEL_REGISTRY = {
  defaultModel: "claude-sonnet-4-20250514",
  providers: [
    {
      id: "anthropic",
      adapter: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: [CLAUDE_SONNET_4_MODEL],
    },
    {
      id: "openai",
      adapter: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [GPT_4O_MODEL],
    },
    {
      id: "deepseek",
      adapter: "anthropic",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com/anthropic",
      models: [DEEPSEEK_V4_FLASH_MODEL],
    },
  ],
} as const satisfies ModelRegistry;

/** Keys starting with "dev-" are mock/placeholder and do not enable live providers. */
export function hasRealApiKey(key: string | undefined): boolean {
  return Boolean(key && key.length > 0 && !key.startsWith("dev-"));
}

function toModelInfo(provider: RegisteredProvider, model: RegisteredModel): ModelInfo {
  return {
    id: model.id,
    provider: provider.id,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: new Set(model.capabilities),
    hostedTools: model.hostedTools ? new Set(model.hostedTools) : undefined,
  };
}

export function buildFromRegistry(
  registry: ModelRegistry,
  env: Record<string, string | undefined>,
): Pick<GatewayConfig, "providers" | "defaultModel"> {
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
      outputUsdPerMillionTokens: model.pricing.outputUsdPerMillionTokens,
      source: model.pricing.source,
    })),
  );
}
