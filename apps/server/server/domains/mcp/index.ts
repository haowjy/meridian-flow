/** Barrel: the MCP connections domain's public surface. */

export { createDrizzleConnectionStore } from "./adapters/drizzle/connection-store.js";
export { CHECK_INTERVAL_MS } from "./domain/connection-checks.js";
export {
  createMcpConnections,
  McpConnectionError,
  type McpConnections,
} from "./domain/connection-service.js";
export { type Resolved, winners } from "./domain/resolve-connections.js";
export { createTokenCipher, parseTokenKey, type TokenCipher } from "./domain/token-cipher.js";
export type { ConnectionRow, ConnectionStore, StoredConnection } from "./ports/connection-store.js";
