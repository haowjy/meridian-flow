/** Drizzle UserRepository: idempotent user provisioning over the `users` table (ensure-on-auth). */

import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { users } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import {
  AccountLinkConflictError,
  type EnsureUserInput,
  type UserRepository,
} from "../../ports/user-repository.js";

export interface DrizzleUserRepositoryDeps {
  db: Database;
}

/** Drizzle-backed {@link UserRepository} over the `users` table. */
export function createDrizzleUserRepository(deps: DrizzleUserRepositoryDeps): UserRepository {
  const { db } = deps;

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      // Every authenticated request lands here, and auth never takes a key-exclusive lock on
      // `users` unless the email changes: naming a unique column in an UPDATE's SET (even to
      // its current value) locks the row `FOR UPDATE`, which queues behind any open
      // transaction holding a key-share on it through a foreign key, with a pooled
      // connection held meanwhile. A plain read and a non-key UPDATE never wait there.
      const [current] = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.externalId, input.externalId))
        .limit(1);
      // This row holds the email (it is unique), so a profile-only change cannot conflict.
      if (current?.email === input.email) {
        if (current.name !== input.name || current.avatarUrl !== input.avatarUrl) {
          await db
            .update(users)
            .set({
              name: input.name,
              avatarUrl: input.avatarUrl,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(users.id, current.id));
        }
        return current.id as UserId;
      }

      return db.transaction(async (tx) => {
        // The lock serializes exact database email keys only; unique indexes
        // remain integrity backstops rather than expected control flow.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-email:${input.email}`}, 0))`,
        );

        const [emailOwner] = await tx
          .select({ externalId: users.externalId })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);
        if (emailOwner && emailOwner.externalId !== input.externalId) {
          throw new AccountLinkConflictError();
        }

        const now = new Date().toISOString();
        const [row] = await tx
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
      });
    },
  };
}
