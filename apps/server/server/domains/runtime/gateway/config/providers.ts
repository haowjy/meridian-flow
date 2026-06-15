/**
 * Gateway env/catalog helpers: mock provider wiring and gateway policy defaults.
 * Static provider/model definitions live in registry.ts; env composition uses
 * buildFromRegistry there.
 */
import type { GatewayConfig, ModelInfo, ProviderConfig } from "../domain/index.js";
import { buildFromRegistry, MODEL_REGISTRY } from "./registry.js";

export interface GatewayEnvInput {
  MODEL_PROVIDER?: "mock" | "anthropic" | "openai" | "auto" | string;
  MODEL_CALL_TIMEOUT_MS?: number;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
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

  return buildFromRegistry(MODEL_REGISTRY, {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  });
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
): Pick<GatewayConfig, "defaultModel" | "retry" | "fallback" | "attemptTimeoutMs"> {
  return {
    defaultModel: defaultModel ?? selectModelStub(providers),
    attemptTimeoutMs: 120_000,
    retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8_000 },
    fallback: { enabled: providers.length > 1 },
  };
}
