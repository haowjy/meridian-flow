/** Drizzle adapter for exact, non-deleted, same-project Work authority resolution. */

import type { ProjectId } from "@meridian/contracts/runtime";
import { decodeWorkSlug, type ResolvedWorkAuthority } from "@meridian/contracts/works";
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
  async function selectBy(
    projectId: ProjectId,
    predicate: ReturnType<typeof eq>,
  ): Promise<ResolvedWorkAuthority | null> {
    const [row] = await currentDrizzleDb(db)
      .select({ workId: works.id, workSlug: works.slug })
      .from(works)
      .where(and(eq(works.projectId, projectId), predicate, isNull(works.deletedAt)))
      .limit(1);
    if (!row) return null;
    const workSlug = decodeWorkSlug(row.workSlug);
    if (!workSlug) throw new Error(`Persisted Work ${row.workId} has an invalid slug`);
    return resolvedWorkAuthority({ kind: "work", workId: row.workId, workSlug });
  }

  return {
    byId: (projectId, workId) => selectBy(projectId, eq(works.id, workId)),
    bySlug: (projectId, workSlug) => selectBy(projectId, eq(works.slug, workSlug)),
    async lockById(projectId, workId) {
      await lockWorkLifecycle(db, workId);
      return selectBy(projectId, eq(works.id, workId));
    },
  };
}
