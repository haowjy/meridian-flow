// @ts-nocheck
/** In-memory UserRepository for tests: Map-backed idempotent user provisioning implementing the port. */
import { randomUUID } from "node:crypto";
import type { UserId } from "@meridian/contracts/runtime";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

type UserRow = EnsureUserInput & {
  id: UserId;
  createdAt: string;
  updatedAt: string;
};

/** In-memory {@link UserRepository} for tests. */
export function createInMemoryUserRepository(): UserRepository {
  const rowsByExternalId = new Map<string, UserRow>();

  function now(): string {
    return new Date().toISOString();
  }

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      const existing = rowsByExternalId.get(input.externalId);
      const timestamp = now();
      const row = {
        ...input,
        id: existing?.id ?? (randomUUID() as UserId),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      rowsByExternalId.set(input.externalId, row);
      return row.id;
    },
  };
}
