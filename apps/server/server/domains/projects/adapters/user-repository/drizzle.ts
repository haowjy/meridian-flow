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

export function createDrizzleUserRepository(deps: DrizzleUserRepositoryDeps): UserRepository {
  const { db } = deps;

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      // Never SET users.email on a no-change update; FOR UPDATE queues behind FK key-share locks
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
