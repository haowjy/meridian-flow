/**
 * The gateway's plain data shapes. Browser-safe: no Node built-ins and no SDKs,
 * so `@meridian-flow/gateway/shapes` can be imported from a client bundle.
 */
export type { JsonValue } from "./json.js";
export type { ProviderErrorResponse } from "./provider-error.js";
export { assertValidUsage, type Usage } from "./usage.js";
