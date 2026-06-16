import type { OnboardingState } from "@meridian/contracts";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";

/**
 * User persistence port: idempotent provisioning of external-auth credentials.
 * `users.id` is Meridian's internal domain user id; `users.external_id` stores the
 * provider credential id (WorkOS). The boundary both user adapters implement.
 */
export interface EnsureUserInput {
  externalId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * Idempotent local user provisioning for external-auth identities. Re-authentication
 * refreshes mutable profile fields and returns the internal domain user id for
 * project/thread/etc. writes that reference `users.id`.
 */
export interface UserRepository {
  ensureUser(input: EnsureUserInput): Promise<UserId>;
  getLastActiveProjectId(userId: UserId): Promise<ProjectId | null>;
  setLastActiveProjectId(userId: UserId, projectId: ProjectId | null): Promise<void>;
  getOnboardingState(userId: UserId): Promise<OnboardingState>;
  updateOnboardingState(userId: UserId, state: OnboardingState): Promise<OnboardingState>;
}
