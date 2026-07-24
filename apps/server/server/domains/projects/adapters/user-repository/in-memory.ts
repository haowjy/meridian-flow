/** In-memory UserRepository for tests: Map-backed idempotent user provisioning implementing the port. */
import { randomUUID } from "node:crypto";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import {
  AccountLinkConflictError,
  type EnsureUserInput,
  type UserRepository,
} from "../../ports/user-repository.js";

type UserRow = EnsureUserInput & {
  id: UserId;
  lastActiveProjectId: ProjectId | null;
  workingSetSyncEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** In-memory {@link UserRepository} for tests. */
export function createInMemoryUserRepository(): UserRepository {
  const rowsByExternalId = new Map<string, UserRow>();

  function now(): string {
    return new Date().toISOString();
  }

  return {
    async ensureUser(input: EnsureUserInput): Promise<UserId> {
      const existing = rowsByExternalId.get(input.externalId);
      const emailOwner = [...rowsByExternalId.values()].find((row) => row.email === input.email);
      if (emailOwner && emailOwner.externalId !== input.externalId) {
        throw new AccountLinkConflictError();
      }
      const timestamp = now();
      const row = {
        ...input,
        id: existing?.id ?? (randomUUID() as UserId),
        lastActiveProjectId: existing?.lastActiveProjectId ?? null,
        workingSetSyncEnabled: existing?.workingSetSyncEnabled ?? true,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      rowsByExternalId.set(input.externalId, row);
      return row.id;
    },
    async getLastActiveProjectId(userId: UserId): Promise<ProjectId | null> {
      for (const row of rowsByExternalId.values()) {
        if (row.id === userId) return row.lastActiveProjectId;
      }
      return null;
    },
    async setLastActiveProjectId(userId: UserId, projectId: ProjectId | null): Promise<void> {
      for (const [externalId, row] of rowsByExternalId.entries()) {
        if (row.id === userId) {
          rowsByExternalId.set(externalId, {
            ...row,
            lastActiveProjectId: projectId,
            updatedAt: now(),
          });
          return;
        }
      }
    },
    async getWorkingSetSyncEnabled(userId: UserId): Promise<boolean> {
      for (const row of rowsByExternalId.values()) {
        if (row.id === userId) return row.workingSetSyncEnabled;
      }
      return true;
    },
    async updateWorkingSetSyncEnabled(userId: UserId, enabled: boolean): Promise<boolean> {
      for (const [externalId, row] of rowsByExternalId.entries()) {
        if (row.id === userId) {
          rowsByExternalId.set(externalId, {
            ...row,
            workingSetSyncEnabled: enabled,
            updatedAt: now(),
          });
          return enabled;
        }
      }
      throw new Error("User settings update did not find the authenticated user");
    },
  };
}
