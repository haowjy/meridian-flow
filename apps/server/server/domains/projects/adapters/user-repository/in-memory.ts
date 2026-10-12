/** In-memory UserRepository for tests: Map-backed idempotent user provisioning implementing the port. */
import { randomUUID } from "node:crypto";
import type { UserId } from "@meridian/contracts/runtime";
import {
  AccountLinkConflictError,
  type EnsureUserInput,
  type UserRepository,
} from "../../ports/user-repository.js";

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
      const emailOwner = [...rowsByExternalId.values()].find((row) => row.email === input.email);
      if (emailOwner && emailOwner.externalId !== input.externalId) {
        throw new AccountLinkConflictError();
      }
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
