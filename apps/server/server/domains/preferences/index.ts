// @ts-nocheck
/** Barrel: re-exports the preferences domain's public surface. */
export { createDrizzleWorkbenchPreferencesRepository } from "./adapters/drizzle/index.js";
export { createInMemoryWorkbenchPreferencesRepository } from "./adapters/in-memory/index.js";
export type { WorkbenchPreferencesRepository } from "./ports/index.js";
