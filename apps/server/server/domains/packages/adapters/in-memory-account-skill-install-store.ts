/** In-memory AccountSkillInstallStore for tests. */
import type { UserId } from "@meridian/contracts/runtime";
import {
  type AccountSkillInstall,
  AccountSkillInstallConflictError,
  type AccountSkillInstallStore,
} from "../ports/account-skill-install-store.js";

export function createInMemoryAccountSkillInstallStore(): AccountSkillInstallStore {
  const rows = new Map<string, AccountSkillInstall>();

  function key(ownerUserId: UserId, slug: string): string {
    return `${ownerUserId}:${slug}`;
  }

  return {
    async insert(input) {
      const id = key(input.ownerUserId, input.slug);
      if (rows.has(id)) throw new AccountSkillInstallConflictError(input.slug);
      const row: AccountSkillInstall = {
        ...input,
        createdAt: new Date().toISOString(),
      };
      rows.set(id, row);
      return row;
    },

    async deleteBySlug(ownerUserId, slug) {
      return rows.delete(key(ownerUserId, slug));
    },

    async listByOwner(ownerUserId) {
      return [...rows.values()]
        .filter((row) => row.ownerUserId === ownerUserId)
        .sort((left, right) => left.slug.localeCompare(right.slug));
    },
  };
}
