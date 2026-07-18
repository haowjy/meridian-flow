/** Map-backed working-set repository that mirrors atomic whole-snapshot upsert semantics. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { copyWorkingSetRow, copyWorkingSetSnapshot } from "../../domain.js";
import type { WorkingSetRepository, WorkingSetRow } from "../../ports/working-set-repository.js";

function rowKey(userId: UserId, projectId: ProjectId): string {
  return `${userId}\u0000${projectId}`;
}

export function createInMemoryWorkingSetRepository(): WorkingSetRepository {
  const rows = new Map<string, WorkingSetRow>();
  return {
    async get(userId, projectId) {
      const row = rows.get(rowKey(userId, projectId));
      return row ? copyWorkingSetRow(row) : null;
    },
    async upsert(userId, projectId, snapshot) {
      const key = rowKey(userId, projectId);
      const current = rows.get(key);
      const revision = current ? current.revision + 1 : 1;
      rows.set(key, {
        userId,
        projectId,
        ...copyWorkingSetSnapshot(snapshot),
        revision,
        updatedAt: new Date(),
      });
      return { revision };
    },
  };
}
