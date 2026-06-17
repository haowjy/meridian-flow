/** In-memory UserRepository for tests: Map-backed idempotent user provisioning implementing the port. */
import { randomUUID } from "node:crypto";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { EnsureUserInput, UserRepository } from "../../ports/user-repository.js";

type UserRow = EnsureUserInput & {
  id: UserId;
  lastActiveProjectId: ProjectId | null;
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
      const timestamp = now();
      const row = {
        ...input,
        id: existing?.id ?? (randomUUID() as UserId),
        lastActiveProjectId: existing?.lastActiveProjectId ?? null,
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
  };
}
