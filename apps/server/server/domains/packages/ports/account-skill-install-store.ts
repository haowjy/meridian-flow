/** Account-owned skill installs. Callers authorize the owner user id. */
import type { UserId } from "@meridian/contracts/runtime";

export interface AccountSkillInstall {
  ownerUserId: UserId;
  slug: string;
  name: string;
  description: string;
  body: string;
  createdAt: string;
}

export class AccountSkillInstallConflictError extends Error {
  readonly name = "AccountSkillInstallConflictError";

  constructor(slug: string) {
    super(`Skill "${slug}" is already installed on this account`);
  }
}

export interface AccountSkillInstallStore {
  insert(input: Omit<AccountSkillInstall, "createdAt">): Promise<AccountSkillInstall>;
  deleteBySlug(ownerUserId: UserId, slug: string): Promise<boolean>;
  listByOwner(ownerUserId: UserId): Promise<AccountSkillInstall[]>;
}
