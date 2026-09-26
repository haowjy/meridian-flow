/**
 * Gateway env/catalog helpers: mock provider wiring and gateway policy defaults.
 * Static provider/model definitions live in registry.ts; env composition uses
 * buildFromRegistry there.
 */

import { DEFAULT_ATTEMPT_CEILING_MS, DEFAULT_ATTEMPT_STALL_MS } from "../deadline.js";
import type { GatewayConfig, ModelInfo, ProviderConfig } from "../domain/index.js";
import { buildFromRegistry, MODEL_REGISTRY } from "./registry.js";

export interface GatewayEnvInput {
  /** Only "mock" has behavior; all other values are ignored so the registry decides. */
  MODEL_PROVIDER?: string;
  /** Absolute per-attempt ceiling in ms; env strings and numbers both accepted. 0 disables. */
  MODEL_CALL_TIMEOUT_MS?: string | number;
  /** Inactivity stall window in ms; env strings and numbers both accepted. 0 disables. */
  MODEL_CALL_STALL_MS?: string | number;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
}

/** Parse an env override to a millisecond count. Unset, empty, or NaN yields undefined. */
export function parseEnvMs(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MOCK_MODEL: ModelInfo = {
  id: "mock-llm-v1",
  provider: "mock",
  displayName: "Mock LLM",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  capabilities: new Set(["streaming", "tool_calling"]),
};

export function mockProviderConfig(baseUrl: string): ProviderConfig {
  return {
    id: "mock",
    adapter: "openai-compatible",
    baseUrl,
    models: [MOCK_MODEL],
  };
}

export function buildProviderConfigs(
  env: GatewayEnvInput,
): Pick<GatewayConfig, "providers" | "defaultModel"> {
  if (env.MODEL_PROVIDER === "mock") {
    return { providers: [], defaultModel: undefined };
  }

  const gatewayConfig = buildFromRegistry(MODEL_REGISTRY, {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  });

  if (!env.OPENROUTER_BASE_URL) return gatewayConfig;

  return {
    ...gatewayConfig,
    providers: gatewayConfig.providers.map((provider) =>
      provider.id === "openrouter" ? { ...provider, baseUrl: env.OPENROUTER_BASE_URL } : provider,
    ),
  };
}

/**
 * Model router — STUB. Future per-request model selection lives here.
 * Today defaultModel comes from the registry (anthropic-first when enabled).
 */
export function selectModelStub(providers: ProviderConfig[]): string | undefined {
  return (
    providers.find((p) => p.id === "anthropic")?.models[0]?.id ??
    providers.find((p) => p.id === "openai")?.models[0]?.id ??
    providers.find((p) => p.id === "deepseek")?.models[0]?.id ??
    providers.find((p) => p.id === "openrouter")?.models[0]?.id ??
    providers.find((p) => p.id === "mock")?.models[0]?.id ??
    providers[0]?.models[0]?.id
  );
}

export function defaultGatewayOptions(
  providers: ProviderConfig[],
  defaultModel?: string,
): Pick<
  GatewayConfig,
  "defaultModel" | "retry" | "fallback" | "attemptStallMs" | "attemptCeilingMs"
> {
  return {
    defaultModel: defaultModel ?? selectModelStub(providers),
    attemptStallMs: DEFAULT_ATTEMPT_STALL_MS,
    attemptCeilingMs: DEFAULT_ATTEMPT_CEILING_MS,
    retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8_000 },
    fallback: { enabled: providers.length > 1 },
  };
}
