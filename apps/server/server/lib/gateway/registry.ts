/**
 * Model/provider registry, built from `models-snapshot.json` (models.dev rows), `families.ts`
 * (which models Flow offers) and `model-data.json` (wire, key, and every fact models.dev lacks,
 * each with its source). Key decisions: provider enablement from each provider's apiKeyEnv. A
 * provider lists offerings: a model plus what that provider charges for it and how it caches it,
 * since the same model can cache and bill differently per provider. Adapter-specific wire checks
 * (cache lifetimes) live in the adapters (`assertModelsOnWire`) and run over every row when a
 * gateway is created from env.
 */

import { effortLevels } from "@meridian-flow/mars-schema";
import type {
  BuiltinAdapter,
  GatewayConfig,
  InputModality,
  PromptCacheDescriptor,
  ProviderConfig,
  ProviderModel,
  ReasoningSupport,
  TokenizerFamily,
} from "@meridian-flow/runtime/gateway";
import {
  createLayeredTokenRateSource,
  MOCK_FIXTURE_TOKEN_RATES,
  type ModelPricing,
  type ModelTokenRate,
  type ModelTokenRateSource,
} from "../../domains/runtime/costing/pricing.js";
import type { ModelFor } from "../../domains/runtime/spawn/resolve-child-invocation.js";
import { findFamily, MODEL_FAMILIES, type ModelFamily, newestInFamily } from "./families.js";
import {
  COMPACTION_SUMMARIZER_MODEL_ID,
  DEFAULT_MODEL_ID,
  factsOf,
  PROVIDERS,
  type ProviderData,
} from "./model-data.js";
import snapshotJson from "./models-snapshot.json" with { type: "json" };

export interface RegisteredModel {
  id: string;
  /** Who made the model, whoever serves it: `model-data.json`, else the models.dev provider the row comes from. */
  maker: string;
  tokenizer: TokenizerFamily;
  /** The picker name: the family alias for its newest model, "alias version" for an older one. */
  displayName: string;
  /** ISO date models.dev lists; the newest model of a family is the one its alias resolves to. */
  releaseDate?: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Copied from models.dev `modalities.input`. */
  inputModalities: readonly InputModality[];
  /** Largest file, in bytes, the provider fetches by link, where its docs state one. */
  maxLinkBytes?: number;
  /** Needs Anthropic's tool-schema projection. */
  projectToolSchema?: true;
  /** Function calls carry ids their results pair with (Gemini 3 and later). */
  functionCallIds?: true;
  reasoning: ReasoningSupport;
}

/** A model as one provider serves it: the price and cache behavior belong to the provider. */
export interface RegisteredOffering {
  model: RegisteredModel;
  pricing: ModelPricing;
  promptCache: PromptCacheDescriptor;
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
  /** The rolling summarizer's model unless the environment names another. Must exist too. */
  compactionSummarizerModel: string;
}

/** The slice of a models.dev model row that Flow reads, keyed in the snapshot by Flow's provider id then model id. */
export interface SnapshotModel {
  name: string;
  /** ISO date. */
  release_date?: string;
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
  return formatUsd(toNano(price * multiplier));
}

/** The levels models.dev lists that are on Mars's ladder, in ladder order (lowest first), plus `none` when the model has a toggle. */
function toReasoning(model: SnapshotModel, thinksByDefault: boolean): ReasoningSupport {
  const effort = model.reasoning_options.find((option) => option.type === "effort");
  const values = effort?.type === "effort" ? effort.values : [];
  const toggle = model.reasoning_options.some((option) => option.type === "toggle");
  const offered = new Set<string>(toggle ? ["none", ...values] : values);
  return {
    efforts: effortLevels().filter((level) => offered.has(level)),
    ...(thinksByDefault ? { thinksByDefault: true as const } : {}),
  };
}

/**
 * The single above-tier step as the multipliers `ModelPricing` carries, or why the row doesn't
 * fit: models.dev gives the tier's own prices, so this holds only when every input-side rate
 * scales by one factor.
 */
function tierOf(
  cost: SnapshotModel["cost"],
): Pick<ModelPricing, "inputTierTokens" | "aboveTierMultipliers"> | string {
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
    return "its cost tiers do not fit one context threshold with one input-side multiplier";
  }
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    inputTierTokens: step.tier.size,
    aboveTierMultipliers: { input: round(ratios[0]), output: round(step.output / cost.output) },
  };
}

/** Why a models.dev row in a family can't be offered, or undefined when Flow can serve it. */
export function unservableReason(model: Partial<SnapshotModel>): string | undefined {
  const { cost, limit, modalities } = model;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") {
    return "models.dev lists no input and output price for it";
  }
  if (!limit || !modalities) return "models.dev lists no limit or input modalities for it";
  if (!model.tool_call) return "it does not support tool calls";
  const tier = tierOf(cost);
  return typeof tier === "string" ? tier : undefined;
}

/** A fact keyed to a model id no snapshot row has: a typo or a retired model, whose facts would fall back to the provider's `"*"` row without a sound. */
function strayFactKeys(snapshot: ModelsSnapshot): string[] {
  return PROVIDERS.flatMap((row) =>
    Object.keys(row.models)
      .filter((id) => id !== "*" && !snapshot.providers[row.id]?.[id])
      .map(
        (id) =>
          `- \`${row.id}/${id}\` has facts in \`model-data.json\`, but the model is not in the snapshot. Delete them.`,
      ),
  );
}

/**
 * Where a provider's price overrides stop short: a model in a family that overrides another of
 * its models but has no override itself, and a rate models.dev lists that an override leaves
 * unset. Either would bill that rate at models.dev's number, not the one Flow pays.
 */
function priceOverrideGaps(snapshot: ModelsSnapshot): string[] {
  return PROVIDERS.flatMap((row) => {
    const rows = snapshot.providers[row.id] ?? {};
    const overrides = Object.fromEntries(
      Object.keys(rows).flatMap((id) => {
        const override = factsOf(row, id).price;
        return override ? [[id, override.value] as const] : [];
      }),
    );
    const overriddenFamilies = new Set(
      Object.keys(overrides).flatMap((id) => findFamily(row.id, id)?.id ?? []),
    );
    return Object.entries(rows).flatMap(([id, model]) => {
      const family = findFamily(row.id, id);
      if (!family || !overriddenFamilies.has(family.id)) return [];
      const { cost } = model;
      const listed = `models.dev lists input $${cost.input}, output $${cost.output}${
        cost.cache_read === undefined ? "" : `, cache read $${cost.cache_read}`
      }${cost.cache_write === undefined ? "" : `, cache write $${cost.cache_write}`}`;
      const override = overrides[id];
      if (!override) {
        return [
          `- \`${row.id}/${id}\` is in family \`${family.id}\`, which has price overrides, but has none itself (${listed}). Add a \`price\` fact for \`${id}\` under \`${row.id}\` in \`model-data.json\` with the rates Flow pays.`,
        ];
      }
      return (["cache_read", "cache_write"] as const)
        .filter((rate) => cost[rate] !== undefined && override[rate] === undefined)
        .map(
          (rate) =>
            `- \`${row.id}/${id}\`: models.dev lists \`${rate}\` $${cost[rate]}, but its price override sets none. Set \`${rate}\` in the override to the rate Flow pays.`,
        );
    });
  });
}

/** Where `model-data.json` and the snapshot disagree. The registry refuses a snapshot with one; the refresh report lists them and builds anyway. */
export function modelDataGaps(snapshot: ModelsSnapshot): string[] {
  return [...strayFactKeys(snapshot), ...priceOverrideGaps(snapshot)];
}

function assertNoModelDataGaps(snapshot: ModelsSnapshot): void {
  const gaps = modelDataGaps(snapshot);
  if (gaps.length > 0) throw new Error(gaps.join("\n"));
}

/** What Flow charges for a row: the provider's override when it has one, else models.dev's cost. */
export function billedCost(row: ProviderData, id: string, cost: SnapshotModel["cost"]) {
  const override = factsOf(row, id).price;
  if (!override) return { cost, override };
  if (cost.tiers) throw new Error(`${row.id}/${id}: a price override cannot sit on context tiers`);
  const { input, output, cache_read, cache_write } = override.value;
  return { cost: { input, output, cache_read, cache_write }, override };
}

function toPricing(
  row: ProviderData,
  snapshot: ModelsSnapshot,
  id: string,
  model: SnapshotModel,
): ModelPricing {
  const { cost, override } = billedCost(row, id, model.cost);
  const { longCacheWrite } = factsOf(row, id);
  const longWrite = longCacheWrite?.value.multiplier;
  const tier = tierOf(cost);
  if (typeof tier === "string") throw new Error(`${row.id}/${id}: ${tier}`);
  const notes = [
    `models.dev snapshot ${snapshot.takenAt}`,
    ...(override ? [`price per ${override.source} (checked ${override.checked})`] : []),
    ...(longCacheWrite
      ? [
          `long-TTL cache write ${longCacheWrite.value.multiplier}x input per ${longCacheWrite.source} (checked ${longCacheWrite.checked})`,
        ]
      : []),
  ];
  return {
    inputUsdPerMillionTokens: usd(cost.input),
    ...(cost.cache_read === undefined
      ? {}
      : { cachedInputUsdPerMillionTokens: usd(cost.cache_read) }),
    ...(cost.cache_write === undefined
      ? {}
      : { cacheWriteUsdPerMillionTokens: usd(cost.cache_write) }),
    ...(longWrite ? { cacheWriteLongUsdPerMillionTokens: usd(cost.input, longWrite) } : {}),
    outputUsdPerMillionTokens: usd(cost.output),
    ...tier,
    source: notes.join("; "),
  };
}

/**
 * Picker names for one family's models: the alias for the newest, "alias version" for the rest.
 * The version is the first number in models.dev's name ("5.1" from "Claude Fable 5.1"). Of
 * several older models with one version, the shortest id keeps "alias version" and each other
 * is marked with what its id adds to that one ("fable 5.1 20261201"), so a name once shown
 * never changes when a sibling arrives.
 */
function pickerNames(
  family: ModelFamily,
  newest: string | null,
  rows: Readonly<Record<string, SnapshotModel>>,
  ids: readonly string[],
): Map<string, string> {
  const version = (id: string) => /\d+(\.\d+)*/.exec(rows[id].name)?.[0] ?? id;
  const older = ids.filter((id) => id !== newest);
  const names = new Map<string, string>(newest === null ? [] : [[newest, family.id]]);
  for (const id of older) {
    const same = older.filter((other) => version(other) === version(id));
    const base = same.reduce((a, b) =>
      b.length < a.length || (b.length === a.length && b < a) ? b : a,
    );
    const mark =
      id === base ? "" : id.startsWith(base) ? id.slice(base.length).replace(/^[-_.]/, "") : id;
    names.set(id, [family.id, version(id), mark].filter(Boolean).join(" "));
  }
  return names;
}

/** The registry the snapshot, the families and the provider rows describe. Throws on a row Flow cannot serve. */
export function buildModelRegistry(snapshot: ModelsSnapshot): ModelRegistry {
  const providers = PROVIDERS.map((row): RegisteredProvider => {
    const rows = snapshot.providers[row.id] ?? {};
    // A snapshot row the allowlist no longer admits stays in the file until the next refresh
    // and gets no offering.
    const offerings = (MODEL_FAMILIES[row.id] ?? []).flatMap((family) => {
      const ids = Object.keys(rows).filter((id) => findFamily(row.id, id) === family);
      const newest = newestInFamily(
        family,
        ids.map((id) => ({ id, provider: row.id, release_date: rows[id].release_date })),
      );
      const names = pickerNames(family, newest, rows, ids);
      return ids.map((id): RegisteredOffering => {
        const model = rows[id];
        const problem = unservableReason(model);
        if (problem) throw new Error(`${row.id}/${id}: ${problem}`);
        const facts = factsOf(row, id);
        if (!facts.tokenizer)
          throw new Error(`${row.id}/${id}: model-data.json gives it no tokenizer`);
        if (!facts.promptCache) {
          throw new Error(`${row.id}/${id}: model-data.json gives it no promptCache`);
        }
        return {
          model: {
            id,
            maker: facts.maker?.value ?? row.modelsDev ?? row.id,
            tokenizer: facts.tokenizer.value,
            displayName: names.get(id) as string,
            ...(model.release_date === undefined ? {} : { releaseDate: model.release_date }),
            contextWindow: model.limit.context,
            maxOutputTokens: model.limit.output,
            inputModalities: model.modalities.input,
            ...(facts.maxLinkBytes ? { maxLinkBytes: facts.maxLinkBytes.value } : {}),
            ...(facts.projectToolSchema ? { projectToolSchema: true as const } : {}),
            ...(facts.functionCallIds ? { functionCallIds: true as const } : {}),
            reasoning: toReasoning(model, facts.thinksByDefault !== undefined),
          },
          pricing: toPricing(row, snapshot, id, model),
          promptCache: facts.promptCache.value,
        };
      });
    });
    return {
      id: row.id,
      adapter: row.adapter,
      apiKeyEnv: row.apiKeyEnv,
      ...(row.baseUrl === undefined ? {} : { baseUrl: row.baseUrl }),
      offerings,
    };
  });
  const names = providers.flatMap((provider) =>
    provider.offerings.map(({ model }) => model.displayName),
  );
  const repeated = names.find((name, at) => names.indexOf(name) !== at);
  if (repeated !== undefined) {
    const clash = providers
      .flatMap((provider) => provider.offerings)
      .filter(({ model }) => model.displayName === repeated)
      .map(({ model }) => model.id);
    throw new Error(`Two models are named "${repeated}" in the picker: ${clash.join(", ")}`);
  }
  const offered = (modelId: string) =>
    providers.some((provider) => provider.offerings.some(({ model }) => model.id === modelId));
  if (!offered(DEFAULT_MODEL_ID)) {
    throw new Error(`The snapshot has no default model ${DEFAULT_MODEL_ID}`);
  }
  if (!offered(COMPACTION_SUMMARIZER_MODEL_ID)) {
    throw new Error(
      `The snapshot has no compaction summarizer model ${COMPACTION_SUMMARIZER_MODEL_ID}`,
    );
  }
  return {
    providers,
    defaultModel: DEFAULT_MODEL_ID,
    compactionSummarizerModel: COMPACTION_SUMMARIZER_MODEL_ID,
  };
}

assertNoModelDataGaps(snapshotJson as ModelsSnapshot);
export const MODEL_REGISTRY: ModelRegistry = buildModelRegistry(snapshotJson as ModelsSnapshot);

/**
 * What an Agent file's `model` names: a picker name (a family alias is its newest model's name,
 * an older one is "fable 5.1") becomes that model's id, and anything else, an exact id included,
 * stays as written. Only models in `available` count, so a provider without a key resolves to
 * nothing and the Agent reports the model as unavailable.
 */
export function resolveModelName(name: string, available: readonly { id: string }[]): string {
  const ids = new Set(available.map((model) => model.id));
  const found = MODEL_REGISTRY.providers
    .flatMap((provider) => provider.offerings)
    .find(({ model }) => model.displayName === name && ids.has(model.id));
  return found?.model.id ?? name;
}

/** The one port that names a model: the gateway's default for no name, else `resolveModelName` over what it offers. */
export function modelFor(gateway: {
  getDefaultModel(): string | undefined;
  listModels(): readonly { id: string }[];
}): ModelFor {
  function name(named: string): string;
  function name(named?: string): string | undefined;
  function name(named?: string): string | undefined {
    return named === undefined
      ? gateway.getDefaultModel()
      : resolveModelName(named, gateway.listModels());
  }
  return name;
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
    const { shortTtlSeconds, longTtlSeconds } = offering.promptCache;
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
    ...(model.projectToolSchema ? { projectToolSchema: true as const } : {}),
    ...(model.functionCallIds ? { functionCallIds: true as const } : {}),
    promptCache: offering.promptCache,
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
