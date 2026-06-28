/**
 * Purpose: Owns deterministic conversion from provider token usage into Meridian
 * millicredits via a layered token-rate source.
 * Key decisions: pinned rates come from the gateway registry (extractPinnedRates);
 * mock/stub fixtures live in an explicit override layer; provider-reported
 * OpenRouter costs bypass token-rate lookup. 1 credit = 1¢ = 1,000 millicredits.
 */

import type { Usage } from "@meridian/contracts/runtime";
import type { JsonObject, PriceSource } from "@meridian/contracts/threads";
import {
  extractPinnedRates,
  MODEL_REGISTRY,
  type PinnedModelRate,
} from "../gateway/config/registry.js";

export interface ModelTokenRate {
  provider: string;
  model: string;
  /** USD per 1,000,000 uncached input tokens. */
  inputUsdPerMillionTokens: string;
  /** USD per 1,000,000 cache-read input tokens, when the provider reports them separately. */
  cachedInputUsdPerMillionTokens?: string;
  /** USD per 1,000,000 cache-write input tokens, when the provider reports them separately. */
  cacheWriteUsdPerMillionTokens?: string;
  /** USD per 1,000,000 output tokens, including reasoning tokens counted in output. */
  outputUsdPerMillionTokens: string;
  source: string;
}

export type ModelTokenRateLayer = "pinned" | "override" | "provider_reported";

export interface ResolvedModelTokenRate extends ModelTokenRate {
  /** Layer that supplied the rate; persisted in pricingSnapshot for audits. */
  sourceLayer: ModelTokenRateLayer;
}

export interface ModelTokenRateSource {
  findRate(provider: string, model: string): ResolvedModelTokenRate | null;
}

export interface LayeredTokenRateSourceDeps {
  /** Registry-extracted pinned rates (base layer). */
  pinnedRates: readonly ModelTokenRate[];
  /** Test/mock zero-rate fixtures excluded from MODEL_REGISTRY. */
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

/** Margin applied to raw provider cost before metering writer usage. */
export const COST_MULTIPLIER = 1.15;

/** Mock and stub models intentionally excluded from MODEL_REGISTRY. */
export const MOCK_FIXTURE_TOKEN_RATES: readonly ModelTokenRate[] = [
  {
    provider: "stub",
    model: "stub",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: ZERO_FIXTURE_SOURCE,
  },
  {
    provider: "stub",
    model: "stub-model",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: ZERO_FIXTURE_SOURCE,
  },
  {
    provider: "mock",
    model: "mock-llm-v1",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: ZERO_FIXTURE_SOURCE,
  },
  {
    provider: "mock",
    model: "mock-model",
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

function pinnedModelRateToTokenRate(rate: PinnedModelRate): ModelTokenRate {
  return {
    provider: rate.provider,
    model: rate.model,
    inputUsdPerMillionTokens: rate.inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens: rate.cachedInputUsdPerMillionTokens,
    cacheWriteUsdPerMillionTokens: rate.cacheWriteUsdPerMillionTokens,
    outputUsdPerMillionTokens: rate.outputUsdPerMillionTokens,
    source: rate.source,
  };
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

export function createDefaultModelTokenRateSource(): ModelTokenRateSource {
  return createLayeredTokenRateSource({
    pinnedRates: extractPinnedRates(MODEL_REGISTRY).map(pinnedModelRateToTokenRate),
    overrideRates: MOCK_FIXTURE_TOKEN_RATES,
  });
}

let defaultRateSource: ModelTokenRateSource | undefined;

export function modelTokenRateSource(): ModelTokenRateSource {
  defaultRateSource ??= createDefaultModelTokenRateSource();
  return defaultRateSource;
}

export function configureModelTokenRateSource(source: ModelTokenRateSource): void {
  defaultRateSource = source;
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
  // $1 = 100 credits = 100,000 millicredits. Apply the fixed 1.15 margin
  // while converting raw USD micros to metered millicredits: ceil(raw * 115 / 1000).
  return rawUsdMicros === 0n
    ? 0n
    : (rawUsdMicros * COST_MULTIPLIER_NUMERATOR + COST_MULTIPLIER_DENOMINATOR - 1n) /
        COST_MULTIPLIER_DENOMINATOR;
}

function pricingSnapshotSource(rate: ResolvedModelTokenRate): string {
  if (rate.sourceLayer === "override") return `override: ${rate.source}`;
  if (rate.sourceLayer === "provider_reported") return "provider_reported";
  return `pinned: ${rate.source}`;
}

function formatUsdFromNumber(usd: number): string {
  return usd.toFixed(6);
}

function usdMicrosFromNumber(usd: number): bigint {
  return parseUsdPerMillion(formatUsdFromNumber(usd));
}

function computeFromProviderReportedCost(input: {
  provider: string;
  model: string;
  reportedCostUsd: number;
}): ComputedModelCost {
  const usdMicros = usdMicrosFromNumber(input.reportedCostUsd);
  return {
    costUsd: formatUsdFromMicros(usdMicros),
    millicredits: meteredMillicreditsFromRaw(usdMicros).toString(),
    priceSource: "provider_reported",
    pricingSnapshot: {
      provider: input.provider,
      model: input.model,
      reportedCostUsd: formatUsdFromNumber(input.reportedCostUsd),
      source: "provider_reported",
      sourceLayer: "provider_reported",
      sourceDetail: "openrouter.providerData.reportedCostUsd",
      unit: "provider_reported_usd",
    },
  };
}

function readOpenRouterProviderData(providerData: unknown): {
  reportedCostUsd?: number;
  meteringStatus?: string;
} {
  if (!providerData || typeof providerData !== "object") {
    return {};
  }
  const record = providerData as Record<string, unknown>;
  const reportedCostUsd = record.reportedCostUsd;
  const meteringStatus = record.meteringStatus;
  return {
    ...(typeof reportedCostUsd === "number" && reportedCostUsd >= 0 ? { reportedCostUsd } : {}),
    ...(typeof meteringStatus === "string" ? { meteringStatus } : {}),
  };
}

function readMeteringStatusFromProviderData(providerData: unknown): string | undefined {
  if (!providerData || typeof providerData !== "object") return undefined;
  const meteringStatus = (providerData as Record<string, unknown>).meteringStatus;
  return typeof meteringStatus === "string" ? meteringStatus : undefined;
}

function readOpenRouterReportedCostUsd(
  provider: string,
  providerData: unknown,
): number | undefined {
  if (provider !== "openrouter") return undefined;
  return readOpenRouterProviderData(providerData).reportedCostUsd;
}

function hasBillableTokenUsage(usage: Usage): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}

function computeMissingUsageCost(input: {
  provider: string;
  model: string;
  providerData: unknown;
}): ComputedModelCost {
  return {
    costUsd: "0.000000",
    millicredits: "0",
    priceSource: "unknown",
    pricingSnapshot: {
      provider: input.provider,
      model: input.model,
      source: "unknown",
      sourceLayer: "provider_reported",
      sourceDetail: `${input.provider}.meteringStatus.missing_usage`,
      usageMeteringStatus: "missing_usage",
      unit: "unmetered",
    },
  };
}

export function findModelTokenRate(
  provider: string,
  model: string,
  rateSource: ModelTokenRateSource = modelTokenRateSource(),
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
  providerData?: unknown;
  rateSource?: ModelTokenRateSource;
}): ComputedModelCost {
  if (readMeteringStatusFromProviderData(input.providerData) === "missing_usage") {
    return computeMissingUsageCost({
      provider: input.provider,
      model: input.model,
      providerData: input.providerData,
    });
  }

  const openRouterData =
    input.provider === "openrouter" ? readOpenRouterProviderData(input.providerData) : {};

  if (openRouterData.meteringStatus === "missing_usage") {
    return computeMissingUsageCost({
      provider: input.provider,
      model: input.model,
      providerData: input.providerData,
    });
  }

  const reportedCostUsd = readOpenRouterReportedCostUsd(input.provider, input.providerData);
  if (reportedCostUsd !== undefined) {
    return computeFromProviderReportedCost({
      provider: input.provider,
      model: input.model,
      reportedCostUsd,
    });
  }

  if (input.provider === "openrouter" && !hasBillableTokenUsage(input.usage)) {
    return computeMissingUsageCost({
      provider: input.provider,
      model: input.model,
      providerData: input.providerData,
    });
  }

  const rate = findModelTokenRate(input.provider, input.model, input.rateSource);
  const cacheReadTokens = input.usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.usage.cacheWriteTokens ?? 0;
  const uncachedInputTokens = Math.max(
    input.usage.inputTokens - cacheReadTokens - cacheWriteTokens,
    0,
  );
  const cachedInputRate = rate.cachedInputUsdPerMillionTokens ?? rate.inputUsdPerMillionTokens;
  const cacheWriteRate = rate.cacheWriteUsdPerMillionTokens ?? rate.inputUsdPerMillionTokens;

  const usdMicros =
    usdMicrosForTokens(uncachedInputTokens, rate.inputUsdPerMillionTokens) +
    usdMicrosForTokens(cacheReadTokens, cachedInputRate) +
    usdMicrosForTokens(cacheWriteTokens, cacheWriteRate) +
    usdMicrosForTokens(input.usage.outputTokens, rate.outputUsdPerMillionTokens);

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
      outputUsdPerMillionTokens: rate.outputUsdPerMillionTokens,
      source: pricingSnapshotSource(rate),
      sourceLayer: rate.sourceLayer,
      sourceDetail: rate.source,
      unit: "usd_per_1m_tokens",
    },
  };
}
