// @ts-nocheck
import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

export interface DrizzleUserRepositoryDeps {
  db: Database;
}

export function createDrizzleUserRepository(_deps: DrizzleUserRepositoryDeps): UserRepository {
  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      return input.externalId as UserId;
    },
  };
}
