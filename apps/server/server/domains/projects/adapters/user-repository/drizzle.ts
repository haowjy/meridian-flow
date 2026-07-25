/** Drizzle UserRepository: idempotent user provisioning over the `users` table (ensure-on-auth). */

import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  AccountLinkConflictError,
  type EnsureUserInput,
  type UserRepository,
} from "../../ports/user-repository.js";

/**
 * `onConflictDoUpdate` arbitrates external_id only. A different principal that
 * claims an existing email therefore raises users_email_unique outside that
 * update path and must fail closed rather than adopting the email owner's row.
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
        const [existing] = await db
          .select({ externalId: users.externalId })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);
        if (!existing) throw error;
        if (existing.externalId !== input.externalId) {
          throw new AccountLinkConflictError();
        }
        throw error;
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
