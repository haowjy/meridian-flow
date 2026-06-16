/** Barrel: re-exports the preferences domain's public surface. */
export { createDrizzleProjectPreferencesRepository } from "./adapters/drizzle/index.js";
export { createInMemoryProjectPreferencesRepository } from "./adapters/in-memory/index.js";
export type { ProjectPreferencesRepository } from "./ports/index.js";
