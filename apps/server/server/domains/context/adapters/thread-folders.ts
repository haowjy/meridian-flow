/** Thread-root association proof: retained live roots outlive thread membership and purge. */
import type { Database } from "@meridian/database";
import { contextSources, threads, threadWorks, works } from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ThreadFolders } from "../ports/thread-folders.js";
import type { AssociatedRoot } from "../tree/placement.js";
import { LIVE_TREE, visibleFolders } from "../tree/tree-view.js";
import { catalogSourceAuthority } from "./catalog-file-mapper.js";

export function createDrizzleThreadFolders(db: Database): ThreadFolders {
  return {
    async resolve(projectId, owner, ref) {
      if (!/^[cp][1-9][0-9]*$/.test(ref)) return null;
      const workId = "workId" in owner ? owner.workId : null;
      const lineageRef = "kind" in owner && owner.kind === "lineage" ? owner.rootThreadRef : null;
      if (!workId && !lineageRef) return null;
      const tx = currentDrizzleDb(db);
      const folders = visibleFolders(LIVE_TREE);
      const [retained] = await tx
        .select({ threadId: folders.threadId })
        .from(folders)
        .innerJoin(contextSources, eq(contextSources.id, folders.contextSourceId))
        .leftJoin(works, eq(works.id, contextSources.workId))
        .leftJoin(threads, eq(threads.id, contextSources.rootThreadId))
        .where(
          and(
            eq(contextSources.slug, "scratch"),
            isNull(contextSources.deletedAt),
            workId
              ? and(eq(works.projectId, projectId), eq(contextSources.workId, workId))
              : and(eq(contextSources.projectId, projectId), eq(threads.ref, lineageRef ?? "")),
            eq(folders.name, `@${ref}`),
            isNull(folders.parentId),
            sql`${folders.threadId} IS NOT NULL`,
          ),
        );
      if (retained?.threadId) return retained.threadId;
      const [member] = await tx
        .select({ id: threads.id })
        .from(threads)
        .leftJoin(
          threadWorks,
          and(
            eq(threadWorks.threadId, threads.id),
            workId ? eq(threadWorks.workId, workId) : sql`false`,
          ),
        )
        .where(
          and(
            eq(threads.projectId, projectId),
            eq(threads.ref, ref),
            workId
              ? sql`${threadWorks.threadId} IS NOT NULL`
              : sql`${threads.rootThreadId} = (SELECT id FROM threads WHERE project_id = ${projectId} AND ref = ${lineageRef} AND root_thread_id = id)`,
          ),
        )
        .limit(1);
      return member?.id ?? null;
    },
  };
}

/** Used inside the source lock by every allocating verb, never by the tree's URI policy. */
export async function associatedRootForSource(
  db: Database,
  sourceId: string,
  dir: readonly string[],
): Promise<AssociatedRoot | undefined> {
  const root = dir[0];
  if (!root?.startsWith("@")) return undefined;
  if (!/^@[cp][1-9][0-9]*$/.test(root)) throw new RangeError("Invalid system folder root");
  const tx = currentDrizzleDb(db);
  const [source] = await tx
    .select({
      projectId: contextSources.projectId,
      workProjectId: works.projectId,
      workId: contextSources.workId,
      workSlug: works.slug,
      rootRef: threads.ref,
      scheme: contextSources.slug,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .leftJoin(threads, eq(threads.id, contextSources.rootThreadId))
    .where(and(eq(contextSources.id, sourceId), isNull(contextSources.deletedAt)));
  const projectId = source?.projectId ?? source?.workProjectId;
  if (source?.scheme !== "scratch" || !projectId)
    throw new RangeError("Thread folder requires Scratch");
  const owner = catalogSourceAuthority("scratch", source.workId, source.workSlug, source.rootRef);
  const threadId = await createDrizzleThreadFolders(db).resolve(projectId, owner, root.slice(1));
  if (!threadId) throw new RangeError("Thread is not associated with this Scratch owner");
  return { name: root, threadId: threadId as import("@meridian/contracts").ThreadId };
}
