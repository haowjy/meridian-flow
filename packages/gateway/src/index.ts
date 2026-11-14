/**
 * Barrel: the model gateway's public surface — the gateway factory, the provider-neutral
 * domain types, message helpers and the shared data shapes. The mock provider is the
 * separate `./mock` entry, which needs `node:http`.
 */

export { assertModelsOnWire, createGateway } from "./create-gateway.js";
export { DEFAULT_ATTEMPT_CEILING_MS, DEFAULT_ATTEMPT_STALL_MS } from "./deadline.js";
export * from "./domain/index.js";
export { assistant, system, text, toolResult, user } from "./helpers/messages.js";
export { ToolCallPairing } from "./helpers/tool-call-pairing.js";
export type { Gateway } from "./ports/gateway.js";
export * from "./shapes/index.js";
