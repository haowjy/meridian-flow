/** Barrel: re-exports the preferences domain's public surface. */

export { createDrizzleAccountSettingsRepository } from "./adapters/drizzle/account-settings-repository.js";
export { createDrizzleProjectPreferencesRepository } from "./adapters/drizzle/project-preferences-repository.js";
export { createInMemoryAccountSettingsRepository } from "./adapters/in-memory/account-settings-repository.js";
export { createInMemoryProjectPreferencesRepository } from "./adapters/in-memory/project-preferences-repository.js";
export type { AccountSettingsRepository } from "./ports/account-settings-repository.js";
export type { ProjectPreferencesRepository } from "./ports/project-preferences-repository.js";
