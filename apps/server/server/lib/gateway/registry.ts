/**
 * Model/provider registry, built from `models-snapshot.json` (models.dev rows), `families.ts`
 * (which models Flow offers) and `provider-rows.ts` (wire, key, cache lifetimes, long-write rates).
 * Key decisions: provider enablement from each provider's apiKeyEnv. A provider lists offerings:
 * a model plus what that provider charges for it and how it caches it, since the same model can
 * cache and bill differently per provider. Adapter-specific wire checks (cache lifetimes) live in
 * the adapters (`assertModelsOnWire`) and run over every row when a gateway is created from env.
 */

import {
  type BuiltinAdapter,
  DEFAULT_PRIMARY_PROMPT_CACHE_TTL,
  DEFAULT_SUBAGENT_PROMPT_CACHE_TTL,
  type GatewayConfig,
  type InputModality,
  type PromptCacheDescriptor,
  type ProviderConfig,
  type ProviderModel,
  REASONING_EFFORTS,
  type ReasoningSupport,
  type TokenizerFamily,
} from "@meridian-flow/runtime/gateway";
import {
  createLayeredTokenRateSource,
  MOCK_FIXTURE_TOKEN_RATES,
  type ModelPricing,
  type ModelTokenRate,
  type ModelTokenRateSource,
} from "../../domains/runtime/costing/pricing.js";
import { DEFAULT_MODEL_ID, findFamily, MODEL_FAMILIES, type ModelFamily } from "./families.js";
import snapshotJson from "./models-snapshot.json" with { type: "json" };
import { PROVIDER_ROWS, type ProviderRow } from "./provider-rows.js";

export interface RegisteredModel {
  id: string;
  tokenizer: TokenizerFamily;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Copied from models.dev `modalities.input`. */
  inputModalities: readonly InputModality[];
  /** Largest file, in bytes, the provider fetches by link, where its docs state one. */
  maxLinkBytes?: number;
  reasoning: ReasoningSupport;
}

/** A model as one provider serves it: the price and cache behavior belong to the provider. */
export interface RegisteredOffering {
  model: RegisteredModel;
  pricing: ModelPricing;
  /**
   * Fields this offering changes from the defaults in `resolvePromptCache`; a field left out
   * keeps the default and `null` stays `null` (the provider documents no lifetime).
   */
  promptCache?: Partial<PromptCacheDescriptor>;
}

export interface RegisteredProvider {
  id: string;
  /** API wire format — maps to ProviderConfig.adapter at build time. */
  adapter: BuiltinAdapter;
  /** Environment variable that must contain a real key for this provider to enable. */
  apiKeyEnv: string;
  baseUrl?: string;
  /** Anthropic-format hosts that need Anthropic's tool-schema projection; the first-party API is the only one today. */
  projectToolSchema?: true;
  offerings: readonly RegisteredOffering[];
}

export interface ModelRegistry {
  providers: readonly RegisteredProvider[];
  /** Model ID used when callers omit a model. Must exist in at least one provider entry. */
  defaultModel: string;
}

/** The slice of a models.dev model row that Flow reads, keyed in the snapshot by Flow's provider id then model id. */
export interface SnapshotModel {
  name: string;
  tool_call: boolean;
  limit: { context: number; output: number };
  modalities: { input: readonly InputModality[] };
  reasoning_options: readonly (
    | { type: "toggle" }
    | { type: "effort"; values: readonly string[] }
    | { type: "budget_tokens"; min?: number }
  )[];
  /** USD per million tokens. */
  cost: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: readonly {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
      tier: { type: string; size: number };
    }[];
  };
}

export interface ModelsSnapshot {
  /** ISO date the snapshot was taken from models.dev. */
  takenAt: string;
  providers: Readonly<Record<string, Readonly<Record<string, SnapshotModel>>>>;
}

// Money stays decimal: nano-dollars as bigint, printed with at least two places.
function toNano(usd: number): bigint {
  return BigInt(Math.round(usd * 1e9));
}

function formatUsd(nano: bigint): string {
  const whole = nano / 1_000_000_000n;
  const fraction = (nano % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function usd(price: number, multiplier = 1): string {
  return formatUsd((toNano(price) * BigInt(Math.round(multiplier * 100))) / 100n);
}

function toReasoning(model: SnapshotModel, family: ModelFamily): ReasoningSupport {
  const effort = model.reasoning_options.find((option) => option.type === "effort");
  const values = effort?.type === "effort" ? effort.values : [];
  const canDisable =
    model.reasoning_options.some((option) => option.type === "toggle") || values.includes("none");
  return {
    efforts: REASONING_EFFORTS.filter((level) => values.includes(level)),
    ...(canDisable ? { canDisable: true as const } : {}),
    ...(family.thinksByDefault ? { thinksByDefault: true as const } : {}),
  };
}

/**
 * The single above-tier step as the multipliers `ModelPricing` carries. models.dev gives the
 * tier's own prices, so this holds only when every input-side rate scales by one factor.
 */
function toTier(
  id: string,
  { cost }: SnapshotModel,
): Pick<ModelPricing, "inputTierTokens" | "aboveTierMultipliers"> {
  const [step, ...rest] = cost.tiers ?? [];
  if (!step) return {};
  const ratios = [
    step.input / cost.input,
    ...(cost.cache_read === undefined || step.cache_read === undefined
      ? []
      : [step.cache_read / cost.cache_read]),
    ...(cost.cache_write === undefined || step.cache_write === undefined
      ? []
      : [step.cache_write / cost.cache_write]),
  ];
  if (
    rest.length > 0 ||
    step.tier.type !== "context" ||
    ratios.some((ratio) => Math.abs(ratio - ratios[0]) > 1e-9)
  ) {
    throw new Error(
      `${id}: models.dev cost tiers do not fit one context threshold with one input-side multiplier`,
    );
  }
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    inputTierTokens: step.tier.size,
    aboveTierMultipliers: { input: round(ratios[0]), output: round(step.output / cost.output) },
  };
}

function toPricing(
  row: ProviderRow,
  snapshot: ModelsSnapshot,
  id: string,
  model: SnapshotModel,
): ModelPricing {
  const { cost } = model;
  const factor = row.rateMultiplier?.multiplier ?? 1;
  const rate = (price: number | undefined) =>
    price === undefined ? undefined : usd(price, factor);
  const cacheRead = rate(cost.cache_read);
  const cacheWrite = rate(cost.cache_write);
  const notes = [
    `models.dev snapshot ${snapshot.takenAt}`,
    ...(row.rateMultiplier
      ? [
          `${row.rateMultiplier.multiplier}x models.dev's rates per ${row.rateMultiplier.source} (checked ${row.rateMultiplier.checked})`,
        ]
      : []),
    ...(row.longCacheWrite
      ? [
          `long-TTL cache write ${row.longCacheWrite.multiplier}x input per ${row.longCacheWrite.source} (checked ${row.longCacheWrite.checked})`,
        ]
      : []),
  ];
  return {
    inputUsdPerMillionTokens: usd(cost.input, factor),
    ...(cacheRead === undefined ? {} : { cachedInputUsdPerMillionTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillionTokens: cacheWrite }),
    ...(row.longCacheWrite
      ? {
          cacheWriteLongUsdPerMillionTokens: usd(
            cost.input,
            factor * row.longCacheWrite.multiplier,
          ),
        }
      : {}),
    outputUsdPerMillionTokens: usd(cost.output, factor),
    ...toTier(id, model),
    source: notes.join("; "),
  };
}

/** The registry the snapshot, the families and the provider rows describe. Throws on a row Flow cannot serve. */
export function buildModelRegistry(snapshot: ModelsSnapshot): ModelRegistry {
  const providers = PROVIDER_ROWS.map((row): RegisteredProvider => {
    const rows = snapshot.providers[row.id] ?? {};
    const families = MODEL_FAMILIES[row.id] ?? [];
    for (const id of Object.keys(rows)) {
      if (!findFamily(row.id, id)) throw new Error(`Snapshot ${row.id}/${id} matches no family`);
    }
    const offerings = families.flatMap((family) =>
      Object.keys(rows)
        .filter((id) => findFamily(row.id, id) === family)
        .map((id): RegisteredOffering => {
          const model = rows[id];
          if (!model.tool_call) throw new Error(`${row.id}/${id} does not support tool calls`);
          return {
            model: {
              id,
              tokenizer: family.tokenizer,
              displayName: model.name,
              contextWindow: model.limit.context,
              maxOutputTokens: model.limit.output,
              inputModalities: model.modalities.input,
              ...(family.maxLinkBytes === undefined ? {} : { maxLinkBytes: family.maxLinkBytes }),
              reasoning: toReasoning(model, family),
            },
            pricing: toPricing(row, snapshot, id, model),
            promptCache: row.promptCache.descriptor,
          };
        }),
    );
    return {
      id: row.id,
      adapter: row.adapter,
      apiKeyEnv: row.apiKeyEnv,
      ...(row.baseUrl === undefined ? {} : { baseUrl: row.baseUrl }),
      ...(row.projectToolSchema ? { projectToolSchema: true as const } : {}),
      offerings,
    };
  });
  const registry = { providers, defaultModel: DEFAULT_MODEL_ID };
  if (
    !providers.some((provider) =>
      provider.offerings.some(({ model }) => model.id === DEFAULT_MODEL_ID),
    )
  ) {
    throw new Error(`The snapshot has no default model ${DEFAULT_MODEL_ID}`);
  }
  return registry;
}

export const MODEL_REGISTRY: ModelRegistry = buildModelRegistry(snapshotJson as ModelsSnapshot);

/** The descriptor `ModelInfo` carries; the validator checks this same value. */
// Every offering starts from explicit breakpoints and the two default lifetimes (Anthropic's).
function resolvePromptCache({ promptCache }: RegisteredOffering): PromptCacheDescriptor {
  return {
    kind: "explicit",
    shortTtlSeconds: DEFAULT_SUBAGENT_PROMPT_CACHE_TTL,
    longTtlSeconds: DEFAULT_PRIMARY_PROMPT_CACHE_TTL,
    ...promptCache,
  };
}

/** Adapter-neutral registry checks, run as soon as a registry is loaded. */
export function validateModelRegistry(registry: ModelRegistry): void {
  for (const offering of registry.providers.flatMap((provider) => provider.offerings)) {
    const { model, pricing } = offering;
    const tier = pricing.inputTierTokens;
    if (
      tier !== undefined &&
      (!Number.isFinite(tier) || tier <= 0 || tier >= model.contextWindow)
    ) {
      throw new Error(
        `Input pricing tier for ${model.id} must be positive and below its context window`,
      );
    }
    const { shortTtlSeconds, longTtlSeconds } = resolvePromptCache(offering);
    if ((shortTtlSeconds === null) !== (longTtlSeconds === null)) {
      throw new Error(`Prompt cache lifetimes for ${model.id} must both be set or both be null`);
    }
    if (shortTtlSeconds !== null && longTtlSeconds !== null) {
      if (longTtlSeconds < shortTtlSeconds) {
        throw new Error(
          `Long prompt cache TTL for ${model.id} must not be shorter than its short TTL`,
        );
      }
      if (
        longTtlSeconds !== shortTtlSeconds &&
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

function toModelInfo(provider: RegisteredProvider, offering: RegisteredOffering): ProviderModel {
  const { model, pricing } = offering;
  return {
    id: model.id,
    provider: provider.id,
    displayName: model.displayName,
    tokenizer: model.tokenizer,
    contextWindow: model.contextWindow,
    inputTierTokens: pricing.inputTierTokens,
    maxOutputTokens: model.maxOutputTokens,
    ...(provider.projectToolSchema ? { projectToolSchema: true as const } : {}),
    promptCache: resolvePromptCache(offering),
    reasoning: model.reasoning,
    inputModalities: model.inputModalities,
    ...(model.maxLinkBytes === undefined ? {} : { maxLinkBytes: model.maxLinkBytes }),
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

/** The rates billing charges: the registry's pinned prices, plus zero rates for the mock model. */
export function registryTokenRateSource(): ModelTokenRateSource {
  return createLayeredTokenRateSource({
    pinnedRates: extractPinnedRates(MODEL_REGISTRY),
    overrideRates: MOCK_FIXTURE_TOKEN_RATES,
  });
}
