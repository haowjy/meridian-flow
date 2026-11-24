/** Barrel: the MCP connections domain's public surface. */

export { createDrizzleCallStore } from "./adapters/drizzle/call-store.js";
export { createDrizzleConnectionStore } from "./adapters/drizzle/connection-store.js";
export {
  type ConnectionBake,
  type ConnectionBaker,
  createConnectionBake,
} from "./domain/connection-bake.js";
export { CHECK_INTERVAL_MS } from "./domain/connection-checks.js";
export {
  createMcpConnections,
  McpConnectionError,
  type McpConnections,
} from "./domain/connection-service.js";
export {
  CALLS_RAN,
  type ConnectionTools,
  createConnectionTools,
  type ReplyStore,
} from "./domain/connection-tools.js";
export { type Resolved, winners } from "./domain/resolve-connections.js";
export {
  createScriptRuns,
  SCRIPT_LIMITS,
  type ScriptLimits,
  type ScriptRuns,
} from "./domain/script-run.js";
export { createTokenCipher, parseTokenKey, type TokenCipher } from "./domain/token-cipher.js";
export type { CallStore } from "./ports/call-store.js";
export type { ConnectionRow, ConnectionStore, StoredConnection } from "./ports/connection-store.js";
