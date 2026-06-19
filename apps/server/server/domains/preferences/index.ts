/** Barrel: re-exports the preferences domain's public surface. */
export { createDrizzleProjectPreferencesRepository } from "./adapters/drizzle/project-preferences-repository.js";
export { createInMemoryProjectPreferencesRepository } from "./adapters/in-memory/project-preferences-repository.js";
export type { ProjectPreferencesRepository } from "./ports/project-preferences-repository.js";
