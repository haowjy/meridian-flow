/**
 * Provider/model catalog and config builders: declares the known models and
 * builds ProviderConfig lists (anthropic, openai, deepseek, mock) plus default
 * gateway options from env input. Owns the static model/provider definitions.
 *
 * Model selection priority (defaultGatewayOptions):
 *   anthropic > openai > deepseek > mock
 * This is a configuration-time default; requests can override with
 * `request.model` or `request.provider`.
 */
import type { GatewayConfig, ModelInfo, ProviderConfig } from "../domain/index.js";

export interface GatewayEnvInput {
  MODEL_PROVIDER?: "mock" | "anthropic" | "openai" | "auto" | string;
  MODEL_CALL_TIMEOUT_MS?: number;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
}

// ── Model definitions ─────────────────────────────────────────────
// Each model entry declares its capabilities. `hostedTools` lists
// provider-side tools (web_search, code_execution, etc.) that the
// orchestrator should NOT dispatch to its own tool executor.

const MOCK_MODEL: ModelInfo = {
  id: "mock-llm-v1",
  provider: "mock",
  displayName: "Mock LLM",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  capabilities: new Set(["streaming", "tool_calling"]),
};

const DEEPSEEK_V4_FLASH: ModelInfo = {
  id: "deepseek-v4-flash",
  provider: "deepseek",
  displayName: "DeepSeek V4 Flash",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  capabilities: new Set(["streaming", "tool_calling", "structured_output", "reasoning"]),
};

const CLAUDE_SONNET_4: ModelInfo = {
  id: "claude-sonnet-4-20250514",
  provider: "anthropic",
  displayName: "Claude Sonnet 4",
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  capabilities: new Set([
    "streaming",
    "tool_calling",
    "image_input",
    "structured_output",
    "reasoning",
    "caching",
  ]),
  hostedTools: new Set([
    "web_search",
    "code_execution",
    "anthropic.text_editor",
    "anthropic.computer_use",
  ]),
};

const GPT_4O: ModelInfo = {
  id: "gpt-4o",
  provider: "openai",
  displayName: "GPT-4o",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  capabilities: new Set([
    "streaming",
    "tool_calling",
    "parallel_tool_calls",
    "image_input",
    "structured_output",
    "reasoning",
  ]),
  hostedTools: new Set(["web_search", "code_execution", "file_search"]),
};

// ── Env key validation ────────────────────────────────────────────
// Keys starting with "dev-" are treated as mock/placeholder keys and
// will not enable the real provider. This prevents accidentally using
// development credentials against production APIs.

function hasRealApiKey(key: string | undefined): boolean {
  return Boolean(key && key.length > 0 && !key.startsWith("dev-"));
}

// ── Provider config builders ──────────────────────────────────────
// Each factory creates a ProviderConfig for one provider. The `adapter`
// field maps to a concrete adapter factory in createAdapter (create-gateway.ts).
//
// Notable: DeepSeek uses the Anthropic adapter because their API is
// Anthropic Messages-compatible (baseUrl points to deepseek's Messages endpoint).
//
// Mock uses openai-compatible because the mock server speaks
// OpenAI Chat Completions over HTTP.

export function mockProviderConfig(baseUrl: string): ProviderConfig {
  return {
    id: "mock",
    adapter: "openai-compatible",
    baseUrl,
    models: [MOCK_MODEL],
  };
}

export function deepseekProviderConfig(apiKey: string): ProviderConfig {
  return {
    id: "deepseek",
    adapter: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    auth: { apiKey },
    models: [DEEPSEEK_V4_FLASH],
  };
}

export function anthropicProviderConfig(apiKey: string): ProviderConfig {
  return {
    id: "anthropic",
    adapter: "anthropic",
    auth: { apiKey },
    models: [CLAUDE_SONNET_4],
  };
}

export function openaiProviderConfig(apiKey: string): ProviderConfig {
  return {
    id: "openai",
    adapter: "openai",
    auth: { apiKey },
    models: [GPT_4O],
  };
}

// ── Build from env ────────────────────────────────────────────────
// Each env key enables one provider. When MODEL_PROVIDER is "mock",
// returns an empty array — the caller in createFromEnv will spin up
// the in-process mock server instead.

export function buildProviderConfigs(env: GatewayEnvInput): ProviderConfig[] {
  const forceMock = env.MODEL_PROVIDER === "mock";
  if (forceMock) return [];

  const providers: ProviderConfig[] = [];

  if (hasRealApiKey(env.ANTHROPIC_API_KEY)) {
    providers.push(anthropicProviderConfig(env.ANTHROPIC_API_KEY as string));
  }

  if (hasRealApiKey(env.OPENAI_API_KEY)) {
    providers.push(openaiProviderConfig(env.OPENAI_API_KEY as string));
  }

  if (hasRealApiKey(env.DEEPSEEK_API_KEY)) {
    providers.push(deepseekProviderConfig(env.DEEPSEEK_API_KEY as string));
  }

  return providers;
}

/**
 * Model router — STUB. This WILL be built out.
 *
 * `MODEL_PROVIDER=auto` is meant to be a real model router: pick the model per
 * request by task difficulty and provider strengths, across the curated
 * multi-provider catalog, hidden from the user. That router does NOT exist yet.
 *
 * Today this stub just returns one static default by provider priority
 * (anthropic > openai > deepseek > mock). When the router lands, replace this
 * function's body (and likely its signature, to take the request/task) — the
 * seam stays here so call sites don't change. Keep this the single place that
 * decides "which model".
 */
export function selectModelStub(providers: ProviderConfig[]): string | undefined {
  return (
    providers.find((p) => p.id === "anthropic")?.models[0]?.id ??
    providers.find((p) => p.id === "openai")?.models[0]?.id ??
    providers.find((p) => p.id === "deepseek")?.models[0]?.id ??
    providers.find((p) => p.id === "mock")?.models[0]?.id ??
    providers[0]?.models[0]?.id
  );
}

export function defaultGatewayOptions(
  providers: ProviderConfig[],
): Pick<GatewayConfig, "defaultModel" | "retry" | "fallback" | "attemptTimeoutMs"> {
  return {
    // STUB: future task-difficulty/strength model router — see selectModelStub.
    defaultModel: selectModelStub(providers),
    attemptTimeoutMs: 120_000,
    retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8_000 },
    fallback: { enabled: providers.length > 1 },
  };
}
