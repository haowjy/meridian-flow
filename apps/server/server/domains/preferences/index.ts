/** Barrel: re-exports the preferences domain's public surface. */

export { createDrizzleAccountSettingsRepository } from "./adapters/drizzle/account-settings-repository.js";
export { createInMemoryAccountSettingsRepository } from "./adapters/in-memory/account-settings-repository.js";
export type { AccountSettingsRepository } from "./ports/account-settings-repository.js";
