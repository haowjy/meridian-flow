/**
 * Barrel: re-exports the gateway's canonical domain types.
 *
 * Consumer modules import `from "./domain/index.js"` (aliased via
 * `"../domain/index.js"` from deeper modules) and get the full type-only
 * contract without reaching into individual files.
 */

export * from "./cancel-settlement.js";
export * from "./types.js";
