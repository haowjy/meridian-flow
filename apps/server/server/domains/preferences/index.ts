// @ts-nocheck
/**
 * Barrel: re-exports the preferences domain's public surface.
 *
 * Meridian Flow does not currently persist copied upstream workbench preferences in
 * the app schema, so keep the production surface on the schema-compatible
 * in-memory adapter. The copied Drizzle adapter stays in-tree as upstream parity
 * reference code, but is intentionally not re-exported because importing it
 * requires a table Meridian has not adopted.
 */
export { createInMemoryWorkbenchPreferencesRepository } from "./adapters/in-memory/index.js";
export type { WorkbenchPreferencesRepository } from "./ports/index.js";
