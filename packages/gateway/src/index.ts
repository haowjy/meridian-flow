/**
 * Barrel: the model gateway's public surface — the gateway factory, the provider-neutral
 * domain types, message helpers and the shared data shapes. The mock provider is the
 * separate `./mock` entry, which needs `node:http`.
 */

// Adapter internals the server's tests drive directly.
export { toAnthropicMessageParams } from "./adapters/anthropic/request-map.js";
export { mapUsage as mapAnthropicUsage } from "./adapters/anthropic/stream-collect.js";
export { mapUsage as mapOpenAIUsage } from "./adapters/openai/stream-collect.js";
export { streamProvider } from "./adapters/provider-stream.js";
export { streamWithRetry } from "./attempt-stream.js";
export { assertModelsOnWire, createGateway } from "./create-gateway.js";
export { DEFAULT_ATTEMPT_CEILING_MS, DEFAULT_ATTEMPT_STALL_MS } from "./deadline.js";
export * from "./domain/index.js";
export { assistant, system, text, toolResult, user } from "./helpers/messages.js";
export type { Gateway } from "./ports/gateway.js";
export type { ProviderAdapter } from "./ports/provider-adapter.js";
export * from "./shapes/index.js";
export {
  isCommittedOutputEvent,
  isFirstTokenEvent,
} from "./stream-events.js";
