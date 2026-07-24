/**
 * Barrel: re-exports the model gateway's public surface — the gateway factory,
 * provider config builders, the mock server, and the canonical domain types.
 *
 * This is the single import entry point for gateway consumers (orchestrator,
 * turn runner, routes). Every public type and factory is re-exported here.
 */
export type { MockOpenAIServer } from "./adapters/mock/server.js";
export { createMockOpenAICompatibleServer } from "./adapters/mock/server.js";
export type { GatewayFromEnv } from "./config/create-from-env.js";
export { createGatewayFromEnv } from "./config/create-from-env.js";
export type { GatewayEnvInput } from "./config/providers.js";
export {
  buildProviderConfigs,
  defaultGatewayOptions,
  mockProviderConfig,
} from "./config/providers.js";
export type {
  ModelPricing,
  ModelRegistry,
  PinnedModelRate,
  RegisteredModel,
  RegisteredProvider,
} from "./config/registry.js";
export {
  buildFromRegistry,
  extractPinnedRates,
  hasRealApiKey,
  MODEL_REGISTRY,
} from "./config/registry.js";
export { consumeStream, GatewayStreamError } from "./consume-stream.js";
export { createGateway, isPartialOutputEvent } from "./create-gateway.js";
export * from "./domain/index.js";
export { assistant, image, system, text, toolResult, user } from "./helpers/messages.js";
export { createInstrumentedGateway } from "./instrumented-gateway.js";
export type { Gateway } from "./ports/gateway.js";
export type { ProviderAdapter } from "./ports/provider-adapter.js";
