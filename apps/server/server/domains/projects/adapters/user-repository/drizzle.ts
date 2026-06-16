/** Drizzle UserRepository: idempotent user provisioning over the `users` table (ensure-on-auth). */

import { OnboardingState, type OnboardingState as OnboardingStateType } from "@meridian/contracts";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { userPreferences, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

export interface DrizzleUserRepositoryDeps {
  db: Database;
}

/** Drizzle-backed {@link UserRepository} over the `users` table. */
export function createDrizzleUserRepository(deps: DrizzleUserRepositoryDeps): UserRepository {
  const { db } = deps;

  function parseOnboardingState(value: unknown): OnboardingStateType {
    return OnboardingState.catch({}).parse(value);
  }

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

    async getOnboardingState(userId: UserId): Promise<OnboardingStateType> {
      const [row] = await db
        .select({ onboardingState: userPreferences.onboardingState })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);
      return parseOnboardingState(row?.onboardingState ?? {});
    },

    async updateOnboardingState(
      userId: UserId,
      state: OnboardingStateType,
    ): Promise<OnboardingStateType> {
      const parsed = parseOnboardingState(state);
      await db
        .insert(userPreferences)
        .values({ userId, onboardingState: parsed })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { onboardingState: parsed, updatedAt: new Date() },
        });
      return parsed;
    },
  };
}
