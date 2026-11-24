import type { UserId } from "@meridian/contracts/runtime";

export interface EnsureUserInput {
  externalId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export class AccountLinkConflictError extends Error {
  readonly name = "AccountLinkConflictError";

  constructor() {
    super("Email is already associated with a different authentication identity");
  }
}

export interface UserRepository {
  ensureUser(input: EnsureUserInput): Promise<UserId>;
}
