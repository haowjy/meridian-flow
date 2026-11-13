/**
 * The dev mock provider: an in-process OpenAI-compatible HTTP server with scripted
 * and sample replies. Its own entry (`@meridian-flow/gateway/mock`) because it needs
 * `node:http`, which the main entry stays free of.
 */
import type { ModelInfo, ProviderConfig } from "./domain/index.js";

export type { MockScriptQueue } from "./adapters/mock/script-queue.js";
export { createMockScriptQueue } from "./adapters/mock/script-queue.js";
export type { MockOpenAIServer } from "./adapters/mock/server.js";
export { createMockOpenAICompatibleServer } from "./adapters/mock/server.js";

const MOCK_MODEL: ModelInfo = {
  id: "mock-llm-v1",
  provider: "mock",
  // The mock has no tokenizer; use the conservative estimation family explicitly.
  tokenizer: "anthropic",
  displayName: "Mock LLM",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  promptCache: { kind: "automatic", shortTtlSeconds: null, longTtlSeconds: null },
  reasoning: { efforts: ["low", "medium", "high", "max"] },
  capabilities: new Set(["image_input"]),
};

export function mockProviderConfig(baseUrl: string): ProviderConfig {
  return {
    id: "mock",
    adapter: "openai-compatible",
    baseUrl,
    models: [MOCK_MODEL],
  };
}
