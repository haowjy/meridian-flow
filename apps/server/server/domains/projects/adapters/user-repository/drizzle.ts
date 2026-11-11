/** Drizzle UserRepository: idempotent user provisioning over the `users` table (ensure-on-auth). */

import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { users } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
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
      // Every authenticated request lands here. A plain read never waits on a row lock; the
      // upsert below takes the row `FOR UPDATE` (it rewrites unique `email`), which queues
      // behind any open write transaction that references the user, and holds a pooled
      // connection while it waits.
      const [current] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.externalId, input.externalId),
            eq(users.email, input.email),
            input.name === null ? isNull(users.name) : eq(users.name, input.name),
            input.avatarUrl === null
              ? isNull(users.avatarUrl)
              : eq(users.avatarUrl, input.avatarUrl),
          ),
        )
        .limit(1);
      if (current) return current.id as UserId;

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
