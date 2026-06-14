// @ts-nocheck
import { OnboardingState, type OnboardingState as OnboardingStateType } from "@meridian/contracts";
import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { userPreferences } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

export interface DrizzleUserRepositoryDeps {
  db: Database;
}

export function createDrizzleUserRepository(deps: DrizzleUserRepositoryDeps): UserRepository {
  const { db } = deps;

  function parseOnboardingState(value: unknown): OnboardingStateType {
    return OnboardingState.catch({}).parse(value);
  }

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      return input.externalId as UserId;
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
