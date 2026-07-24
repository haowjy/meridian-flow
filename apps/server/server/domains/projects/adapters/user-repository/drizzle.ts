/** Drizzle UserRepository: idempotent user provisioning over the `users` table (ensure-on-auth). */

import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

/**
 * A concurrent provisioning of the same email under a *different* external id
 * surfaces here: `onConflictDoUpdate` can only arbitrate one unique index
 * (external_id), so a simultaneous insert that already claimed
 * `users_email_unique` raises a raw `23505` instead of taking the update path.
 * We converge on the row that won the race rather than tripping the 500 boundary.
 */
function isEmailUniqueViolation(error: unknown): boolean {
  let cause: unknown = error;
  while (cause) {
    if (
      typeof cause === "object" &&
      (cause as { code?: unknown }).code === "23505" &&
      (cause as { constraint_name?: unknown }).constraint_name === "users_email_unique"
    ) {
      return true;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export interface DrizzleUserRepositoryDeps {
  db: Database;
}

/** Drizzle-backed {@link UserRepository} over the `users` table. */
export function createDrizzleUserRepository(deps: DrizzleUserRepositoryDeps): UserRepository {
  const { db } = deps;

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      const now = new Date().toISOString();
      try {
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
      } catch (error) {
        if (!isEmailUniqueViolation(error)) throw error;
        // The email is already provisioned (race winner committed first). Adopt
        // that canonical account and refresh mutable profile fields to match the
        // just-authenticated session. `email` is unique by schema, so one email
        // maps to exactly one account.
        const [existing] = await db
          .update(users)
          .set({ name: input.name, avatarUrl: input.avatarUrl, updatedAt: now })
          .where(eq(users.email, input.email))
          .returning({ id: users.id });
        if (!existing) throw error;
        return existing.id as UserId;
      }
    },

    async getLastActiveProjectId(userId: UserId): Promise<ProjectId | null> {
      const [row] = await db
        .select({ lastActiveProjectId: users.lastActiveProjectId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return (row?.lastActiveProjectId as ProjectId | null | undefined) ?? null;
    },

    async setLastActiveProjectId(userId: UserId, projectId: ProjectId | null): Promise<void> {
      await db
        .update(users)
        .set({ lastActiveProjectId: projectId, updatedAt: new Date().toISOString() })
        .where(eq(users.id, userId));
    },

    async getWorkingSetSyncEnabled(userId: UserId): Promise<boolean> {
      const [row] = await db
        .select({ enabled: users.workingSetSyncEnabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row?.enabled ?? true;
    },

    async updateWorkingSetSyncEnabled(userId: UserId, enabled: boolean): Promise<boolean> {
      const [row] = await db
        .update(users)
        .set({ workingSetSyncEnabled: enabled, updatedAt: new Date().toISOString() })
        .where(eq(users.id, userId))
        .returning({ enabled: users.workingSetSyncEnabled });
      if (!row) throw new Error("User settings update did not find the authenticated user");
      return row.enabled;
    },
  };
}
