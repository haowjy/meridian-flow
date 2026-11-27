import { assertValidUsage, type Usage } from "@meridian/contracts/runtime";
import type { JsonObject, PriceSource } from "@meridian/contracts/threads";

export interface ModelPricing {
  inputTierTokens?: number;
  aboveTierMultipliers?: { input: number; output: number };
  inputUsdPerMillionTokens: string;
  outputUsdPerMillionTokens: string;
  cachedInputUsdPerMillionTokens?: string;
  cacheWriteUsdPerMillionTokens?: string;
  cacheWriteLongUsdPerMillionTokens?: string;
  source: string;
}

export type ModelTokenRate = ModelPricing & { provider: string; model: string };

export type ModelTokenRateLayer = "pinned" | "override" | "unmetered";

export interface ResolvedModelTokenRate extends ModelTokenRate {
  sourceLayer: ModelTokenRateLayer;
}

export interface ModelTokenRateSource {
  findRate(provider: string, model: string): ResolvedModelTokenRate | null;
}

export interface LayeredTokenRateSourceDeps {
  pinnedRates: readonly ModelTokenRate[];
  overrideRates?: readonly ModelTokenRate[];
}

export interface ComputedModelCost {
  costUsd: string;
  millicredits: string;
  priceSource: PriceSource;
  pricingSnapshot: JsonObject;
}

const ZERO_FIXTURE_SOURCE = "in-process test/mock fixture";
const COST_MULTIPLIER_NUMERATOR = 115n;
const COST_MULTIPLIER_DENOMINATOR = 1000n;

export const MOCK_FIXTURE_TOKEN_RATES: readonly ModelTokenRate[] = [
  {
    provider: "mock",
    model: "mock-llm-v1",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: ZERO_FIXTURE_SOURCE,
  },
];

function rateKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}::${model.toLowerCase()}`;
}

function indexRates(
  rates: readonly ModelTokenRate[],
  sourceLayer: ModelTokenRateLayer,
): Map<string, ResolvedModelTokenRate> {
  return new Map(
    rates.map((rate) => [rateKey(rate.provider, rate.model), { ...rate, sourceLayer }]),
  );
}

export function createLayeredTokenRateSource(
  deps: LayeredTokenRateSourceDeps,
): ModelTokenRateSource {
  const overrides = indexRates(deps.overrideRates ?? [], "override");
  const pinned = indexRates(deps.pinnedRates, "pinned");

  return {
    findRate(provider: string, model: string): ResolvedModelTokenRate | null {
      const key = rateKey(provider, model);
      return overrides.get(key) ?? pinned.get(key) ?? null;
    },
  };
}

function parseUsdPerMillion(decimal: string): bigint {
  const [whole, fraction = ""] = decimal.split(".");
  const paddedFraction = `${fraction}000000`.slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(paddedFraction);
}

function usdMicrosForTokens(tokens: number, usdPerMillionTokens: string): bigint {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`Token count must be a non-negative integer; got ${tokens}`);
  }
  return (BigInt(tokens) * parseUsdPerMillion(usdPerMillionTokens)) / 1_000_000n;
}

function formatUsdFromMicros(usdMicros: bigint): string {
  const whole = usdMicros / 1_000_000n;
  const fraction = (usdMicros % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function meteredMillicreditsFromRaw(rawUsdMicros: bigint): bigint {
  return rawUsdMicros === 0n
    ? 0n
    : (rawUsdMicros * COST_MULTIPLIER_NUMERATOR + COST_MULTIPLIER_DENOMINATOR - 1n) /
        COST_MULTIPLIER_DENOMINATOR;
}

function pricingSnapshotSource(rate: ResolvedModelTokenRate): string {
  return rate.sourceLayer === "override" ? `override: ${rate.source}` : rate.source;
}

function computeMissingUsageCost(input: { provider: string; model: string }): ComputedModelCost {
  return {
    costUsd: "0.000000",
    millicredits: "0",
    priceSource: "unknown",
    pricingSnapshot: {
      provider: input.provider,
      model: input.model,
      source: "unknown",
      sourceLayer: "unmetered",
      sourceDetail: `${input.provider}.meteringStatus.missing_usage`,
      usageMeteringStatus: "missing_usage",
      unit: "unmetered",
    },
  };
}

function findModelTokenRate(
  provider: string,
  model: string,
  rateSource: ModelTokenRateSource,
): ResolvedModelTokenRate {
  const rate = rateSource.findRate(provider, model);
  if (!rate) {
    throw new Error(`No pinned token price for provider=${provider} model=${model}`);
  }
  return rate;
}

export function computeModelCost(input: {
  provider: string;
  model: string;
  usage: Usage;
  meteringStatus?: "missing_usage";
  rateSource: ModelTokenRateSource;
}): ComputedModelCost {
  assertValidUsage(input.usage);

  if (input.meteringStatus === "missing_usage") {
    return computeMissingUsageCost({ provider: input.provider, model: input.model });
  }

  const rate = findModelTokenRate(input.provider, input.model, input.rateSource);
  const cacheReadTokens = input.usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.usage.cacheWriteTokens ?? 0;
  const cacheWriteLongTokens = input.usage.cacheWriteLongTokens ?? 0;
  const uncachedInputTokens = input.usage.inputTokens - cacheReadTokens - cacheWriteTokens;
  const cachedInputRate = rate.cachedInputUsdPerMillionTokens ?? rate.inputUsdPerMillionTokens;
  const cacheWriteRate = rate.cacheWriteUsdPerMillionTokens ?? rate.inputUsdPerMillionTokens;
  const cacheWriteLongRate = rate.cacheWriteLongUsdPerMillionTokens ?? cacheWriteRate;

  const surcharge =
    rate.inputTierTokens !== undefined && input.usage.inputTokens > rate.inputTierTokens
      ? rate.aboveTierMultipliers
      : undefined;
  const scaled = (micros: bigint, multiplier = 1) =>
    (micros * BigInt(Math.round(multiplier * 100))) / 100n;

  const usdMicros =
    scaled(
      usdMicrosForTokens(uncachedInputTokens, rate.inputUsdPerMillionTokens) +
        usdMicrosForTokens(cacheReadTokens, cachedInputRate) +
        usdMicrosForTokens(cacheWriteTokens - cacheWriteLongTokens, cacheWriteRate) +
        usdMicrosForTokens(cacheWriteLongTokens, cacheWriteLongRate),
      surcharge?.input,
    ) +
    scaled(
      usdMicrosForTokens(input.usage.outputTokens, rate.outputUsdPerMillionTokens),
      surcharge?.output,
    );

  return {
    costUsd: formatUsdFromMicros(usdMicros),
    millicredits: meteredMillicreditsFromRaw(usdMicros).toString(),
    priceSource: "computed",
    pricingSnapshot: {
      provider: rate.provider,
      model: rate.model,
      inputUsdPerMillionTokens: rate.inputUsdPerMillionTokens,
      cachedInputUsdPerMillionTokens: rate.cachedInputUsdPerMillionTokens ?? null,
      cacheWriteUsdPerMillionTokens: rate.cacheWriteUsdPerMillionTokens ?? null,
      cacheWriteLongUsdPerMillionTokens: rate.cacheWriteLongUsdPerMillionTokens ?? null,
      outputUsdPerMillionTokens: rate.outputUsdPerMillionTokens,
      inputTierTokens: rate.inputTierTokens ?? null,
      aboveTierMultipliers: rate.aboveTierMultipliers ?? null,
      source: pricingSnapshotSource(rate),
      sourceLayer: rate.sourceLayer,
      sourceDetail: rate.source,
      unit: "usd_per_1m_tokens",
    },
  };
}
