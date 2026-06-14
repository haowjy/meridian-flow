// @ts-nocheck
/**
 * Purpose: Owns the deterministic model token-price table and conversion from
 * provider token usage into Meridian millicredits.
 * Key decisions: prices are pinned per provider+model, expressed as USD per
 * one million tokens from provider pricing pages, then converted with integer
 * arithmetic where 1 credit = 1¢ and 1 credit = 1,000 millicredits. Unknown
 * production models throw loudly so billing can never silently record zero.
 */

import type { Usage } from "@meridian/contracts/runtime";
import type { JsonObject } from "@meridian/contracts/threads";

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

export interface ComputedModelCost {
  costUsd: string;
  millicredits: string;
  pricingSnapshot: JsonObject;
}

const OPENAI_PRICING_SOURCE = "https://openai.com/api/pricing/ (pinned 2026-06-10)";
const ANTHROPIC_PRICING_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing (pinned 2026-06-10)";
const DEEPSEEK_PRICING_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing (pinned 2026-06-10)";

export const MODEL_TOKEN_RATES: readonly ModelTokenRate[] = [
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputUsdPerMillionTokens: "0.40",
    cachedInputUsdPerMillionTokens: "0.10",
    outputUsdPerMillionTokens: "1.60",
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    inputUsdPerMillionTokens: "2.00",
    cachedInputUsdPerMillionTokens: "0.50",
    outputUsdPerMillionTokens: "8.00",
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputUsdPerMillionTokens: "0.15",
    cachedInputUsdPerMillionTokens: "0.075",
    outputUsdPerMillionTokens: "0.60",
    source: OPENAI_PRICING_SOURCE,
  },
  // Gateway catalog coverage: providers.ts can emit gpt-4o in live OpenAI mode.
  // Source: OpenAI API pricing calculator/page, pinned 2026-06-10.
  {
    provider: "openai",
    model: "gpt-4o",
    inputUsdPerMillionTokens: "2.50",
    cachedInputUsdPerMillionTokens: "1.25",
    outputUsdPerMillionTokens: "10.00",
    source: OPENAI_PRICING_SOURCE,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputUsdPerMillionTokens: "3.00",
    cachedInputUsdPerMillionTokens: "0.30",
    cacheWriteUsdPerMillionTokens: "3.75",
    outputUsdPerMillionTokens: "15.00",
    source: ANTHROPIC_PRICING_SOURCE,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    inputUsdPerMillionTokens: "1.00",
    cachedInputUsdPerMillionTokens: "0.10",
    cacheWriteUsdPerMillionTokens: "1.25",
    outputUsdPerMillionTokens: "5.00",
    source: ANTHROPIC_PRICING_SOURCE,
  },
  // Gateway catalog coverage: providers.ts can emit claude-sonnet-4-20250514.
  // Source: Anthropic Claude 4 launch/API pricing, pinned 2026-06-10.
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputUsdPerMillionTokens: "3.00",
    cachedInputUsdPerMillionTokens: "0.30",
    cacheWriteUsdPerMillionTokens: "3.75",
    outputUsdPerMillionTokens: "15.00",
    source: ANTHROPIC_PRICING_SOURCE,
  },
  // Gateway env/default compatibility: older env defaults can still request
  // claude-3-5-haiku-latest. Source: Anthropic API pricing, pinned 2026-06-10.
  {
    provider: "anthropic",
    model: "claude-3-5-haiku-latest",
    inputUsdPerMillionTokens: "0.80",
    cachedInputUsdPerMillionTokens: "0.08",
    cacheWriteUsdPerMillionTokens: "1.00",
    outputUsdPerMillionTokens: "4.00",
    source: ANTHROPIC_PRICING_SOURCE,
  },
  // Gateway catalog coverage: providers.ts can emit deepseek-v4-flash.
  // Source: DeepSeek published Models & Pricing table, pinned 2026-06-10.
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    inputUsdPerMillionTokens: "0.14",
    cachedInputUsdPerMillionTokens: "0.0028",
    outputUsdPerMillionTokens: "0.28",
    source: DEEPSEEK_PRICING_SOURCE,
  },
  // Test-only provider used by in-process gateway stubs. Keeping it explicit
  // preserves loud unknown-model behavior without making fixture-heavy tests
  // depend on live vendor model names.
  {
    provider: "stub",
    model: "stub",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: "in-process test fixture",
  },
  {
    provider: "stub",
    model: "stub-model",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: "in-process test fixture",
  },
  {
    provider: "mock",
    model: "mock-llm-v1",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: "in-process mock gateway fixture",
  },
  {
    provider: "mock",
    model: "mock-model",
    inputUsdPerMillionTokens: "0",
    cachedInputUsdPerMillionTokens: "0",
    cacheWriteUsdPerMillionTokens: "0",
    outputUsdPerMillionTokens: "0",
    source: "in-process mock gateway fixture",
  },
];

function rateKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}::${model.toLowerCase()}`;
}

const RATES_BY_PROVIDER_MODEL = new Map(
  MODEL_TOKEN_RATES.map((rate) => [rateKey(rate.provider, rate.model), rate]),
);

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

function millicreditsFromUsdMicros(usdMicros: bigint): bigint {
  // $1 = 100 credits = 100,000 millicredits, so 1 USD micro = 0.1 millicredit.
  // Round up: a positive computed call should not become a free zero debit.
  return usdMicros === 0n ? 0n : (usdMicros * 100_000n + 999_999n) / 1_000_000n;
}

export function findModelTokenRate(provider: string, model: string): ModelTokenRate {
  const rate = RATES_BY_PROVIDER_MODEL.get(rateKey(provider, model));
  if (!rate) {
    throw new Error(`No pinned token price for provider=${provider} model=${model}`);
  }
  return rate;
}

export function computeModelCost(input: {
  provider: string;
  model: string;
  usage: Usage;
}): ComputedModelCost {
  const rate = findModelTokenRate(input.provider, input.model);
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
    millicredits: millicreditsFromUsdMicros(usdMicros).toString(),
    pricingSnapshot: {
      provider: rate.provider,
      model: rate.model,
      inputUsdPerMillionTokens: rate.inputUsdPerMillionTokens,
      cachedInputUsdPerMillionTokens: rate.cachedInputUsdPerMillionTokens ?? null,
      cacheWriteUsdPerMillionTokens: rate.cacheWriteUsdPerMillionTokens ?? null,
      outputUsdPerMillionTokens: rate.outputUsdPerMillionTokens,
      source: rate.source,
      unit: "usd_per_1m_tokens",
    },
  };
}
