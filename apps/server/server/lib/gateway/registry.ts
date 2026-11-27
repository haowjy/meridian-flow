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
  maker: string;
  tokenizer: TokenizerFamily;
  displayName: string;
  releaseDate?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: readonly InputModality[];
  maxLinkBytes?: number;
  projectToolSchema?: true;
  functionCallIds?: true;
  reasoning: ReasoningSupport;
}

export interface RegisteredOffering {
  model: RegisteredModel;
  pricing: ModelPricing;
  promptCache: PromptCacheDescriptor;
}

export interface RegisteredProvider {
  id: string;
  adapter: BuiltinAdapter;
  apiKeyEnv: string;
  baseUrl?: string;
  testOnly?: true;
  offerings: readonly RegisteredOffering[];
}

export interface ModelRegistry {
  providers: readonly RegisteredProvider[];
  defaultModel: string;
  compactionSummarizerModel: string;
}

export interface SnapshotModel {
  name: string;
  release_date?: string;
  tool_call: boolean;
  limit: { context: number; output: number };
  modalities: { input: readonly InputModality[] };
  reasoning_options: readonly (
    | { type: "toggle" }
    | { type: "effort"; values: readonly string[] }
    | { type: "budget_tokens"; min?: number }
  )[];
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
  takenAt: string;
  providers: Readonly<Record<string, Readonly<Record<string, SnapshotModel>>>>;
}

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

export function modelDataGaps(snapshot: ModelsSnapshot): string[] {
  return [...strayFactKeys(snapshot), ...priceOverrideGaps(snapshot)];
}

function assertNoModelDataGaps(snapshot: ModelsSnapshot): void {
  const gaps = modelDataGaps(snapshot);
  if (gaps.length > 0) throw new Error(gaps.join("\n"));
}

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

export function buildModelRegistry(snapshot: ModelsSnapshot): ModelRegistry {
  const providers = PROVIDERS.map((row): RegisteredProvider => {
    const rows = snapshot.providers[row.id] ?? {};
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
      ...(row.testOnly ? { testOnly: true as const } : {}),
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

export function resolveModelName(name: string, available: readonly { id: string }[]): string {
  const ids = new Set(available.map((model) => model.id));
  const found = MODEL_REGISTRY.providers
    .flatMap((provider) => provider.offerings)
    .find(({ model }) => model.displayName === name && ids.has(model.id));
  return found?.model.id ?? name;
}

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
  const defaultModel = enabledModelIds.has(registry.defaultModel)
    ? registry.defaultModel
    : undefined;

  return { providers, defaultModel };
}

export function extractPinnedRates(registry: ModelRegistry): ModelTokenRate[] {
  return registry.providers.flatMap((provider) =>
    provider.offerings.map(({ model, pricing }) => ({
      provider: provider.id,
      model: model.id,
      ...pricing,
    })),
  );
}

export function registryTokenRateSource(): ModelTokenRateSource {
  return createLayeredTokenRateSource({
    pinnedRates: extractPinnedRates(MODEL_REGISTRY),
    overrideRates: MOCK_FIXTURE_TOKEN_RATES,
  });
}
