/**
 * User persistence port: idempotent provisioning of external-auth credentials.
 * `users.id` is Meridian's internal domain user id; `users.external_id` stores the
 * provider credential id (WorkOS). The boundary both user adapters implement.
 */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";

export interface EnsureUserInput {
  externalId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/** An email belongs to a different provider identity and cannot be linked automatically. */
export class AccountLinkConflictError extends Error {
  readonly name = "AccountLinkConflictError";

  constructor() {
    super("Email is already associated with a different authentication identity");
  }
}

/**
 * Idempotent local user provisioning for external-auth identities. Re-authentication
 * refreshes mutable profile fields and returns the internal domain user id for
 * project/thread/etc. writes that reference `users.id`. The provider external id
 * is the sole automatic identity key; email collisions never merge accounts.
 */
export interface UserRepository {
  ensureUser(input: EnsureUserInput): Promise<UserId>;
  getLastActiveProjectId(userId: UserId): Promise<ProjectId | null>;
  setLastActiveProjectId(userId: UserId, projectId: ProjectId | null): Promise<void>;
  getWorkingSetSyncEnabled(userId: UserId): Promise<boolean>;
  updateWorkingSetSyncEnabled(userId: UserId, enabled: boolean): Promise<boolean>;
}
