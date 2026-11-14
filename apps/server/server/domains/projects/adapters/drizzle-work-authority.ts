/** Drizzle adapter for exact, same-project Work authority resolution. */

import type { ProjectId } from "@meridian/contracts/runtime";
import { decodeWorkHandle, type ResolvedWorkAuthority } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockWorkLifecycle } from "../../../shared/work-lifecycle-lock.js";
import {
  type ProjectWorkAuthorityResolver,
  resolvedWorkAuthority,
} from "../domain/work-authority.js";

export function createDrizzleProjectWorkAuthorityResolver(
  db: Database,
): ProjectWorkAuthorityResolver {
  /** `restorable`: a deleted Work counts until its purge removes the row. */
  function selectWhere(projectId: ProjectId, predicate: ReturnType<typeof eq>, restorable = true) {
    return currentDrizzleDb(db)
      .select({ workId: works.id, workHandle: works.handle, isNoWork: works.isNoWork })
      .from(works)
      .where(
        and(
          eq(works.projectId, projectId),
          predicate,
          restorable ? undefined : isNull(works.deletedAt),
        ),
      );
  }

  function authorityOf(row: {
    workId: string;
    workHandle: string | null;
    isNoWork: boolean;
  }): ResolvedWorkAuthority {
    if (row.isNoWork) return resolvedWorkAuthority({ workId: row.workId, workHandle: null });
    const workHandle = decodeWorkHandle(row.workHandle);
    if (!workHandle) throw new Error(`Persisted Work ${row.workId} has an invalid handle`);
    return resolvedWorkAuthority({ workId: row.workId, workHandle });
  }

  async function selectBy(
    projectId: ProjectId,
    predicate: ReturnType<typeof eq>,
    restorable = true,
  ): Promise<ResolvedWorkAuthority | null> {
    const [row] = await selectWhere(projectId, predicate, restorable).limit(1);
    return row ? authorityOf(row) : null;
  }

  return {
    byId: (projectId, workId) => selectBy(projectId, eq(works.id, workId)),
    byHandle: (projectId, workHandle) => selectBy(projectId, eq(works.handle, workHandle)),
    noWork: (projectId) => selectBy(projectId, eq(works.isNoWork, true)),
    async listForProject(projectId) {
      return (await selectWhere(projectId, eq(works.isNoWork, false))).map(authorityOf);
    },
    async lockById(projectId, workId) {
      await lockWorkLifecycle(db, workId);
      return selectBy(projectId, eq(works.id, workId), false);
    },
  };
}
