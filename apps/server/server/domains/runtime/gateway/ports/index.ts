// @ts-nocheck
/**
 * Barrel: re-exports the gateway port (Gateway) and the provider-adapter port
 * (ProviderAdapter). These are the two interface seams that decouple the
 * gateway orchestrator from concrete provider implementations.
 */
export type { Gateway } from "./gateway.js";
export type { ProviderAdapter } from "./provider-adapter.js";
