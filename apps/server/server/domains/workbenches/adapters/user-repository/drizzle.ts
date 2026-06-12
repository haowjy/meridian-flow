// @ts-nocheck
/** Drizzle UserRepository: idempotent user provisioning over the `users` table (ensure-on-auth). Depends inward on the user-repository port. */

import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { users } from "@meridian/database/schema";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

export interface DrizzleUserRepositoryDeps {
  db: Database;
}

/** Drizzle-backed {@link UserRepository} over the `schema` users table. */
export function createDrizzleUserRepository(deps: DrizzleUserRepositoryDeps): UserRepository {
  const { db } = deps;

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      const now = new Date().toISOString();
      const [row] = await db
        .insert(users)
        .values({
          externalId: input.externalId,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: users.externalId,
          set: {
            email: input.email,
            name: input.name,
            avatarUrl: input.avatarUrl,
            updatedAt: now,
          },
        })
        .returning({ id: users.id });
      if (!row) {
        throw new Error("User provisioning did not return an internal user id");
      }
      return row.id as UserId;
    },
  };
}
