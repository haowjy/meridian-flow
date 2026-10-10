/** In-memory account settings adapter for composed tests. */
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import type { AccountSettingsRepository } from "../../ports/account-settings-repository.js";
export function createInMemoryAccountSettingsRepository(): AccountSettingsRepository {
  const rows = new Map<string, AccountSettings>();
  return {
    async read(id) {
      return { ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: true, ...rows.get(id) };
    },
    async update(id, patch) {
      const value = { ...(await this.read(id)), ...patch };
      rows.set(id, value);
      return { ...value };
    },
  };
}
