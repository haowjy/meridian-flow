import {
  type DraftId,
  type DraftOwner,
  newDraftId,
  type ProjectId,
  type ThreadId,
  type UserId,
  type WorkId,
} from "@meridian/contracts";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import { drafts, threads, works } from "@meridian/database/schema";
import { and, eq, inArray, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

export type OwnerLocks = { workIds: string[]; lineageRootIds: string[] };

export function mergeOwnerLocks(...sets: readonly OwnerLocks[]): OwnerLocks {
  return {
    workIds: [...new Set(sets.flatMap((set) => set.workIds))].sort(),
    lineageRootIds: [...new Set(sets.flatMap((set) => set.lineageRootIds))].sort(),
  };
}

export type DraftOwnerLifecycle = "active" | "archived" | "frozen" | "deleted" | "missing";

export function closedOwnerOf(lifecycle: DraftOwnerLifecycle): ClosedOwnerWhy | null {
  switch (lifecycle) {
    case "active":
      return null;
    case "archived":
      return "work_archived";
    case "frozen":
      return "chat_frozen";
    case "deleted":
    case "missing":
      return "work_deleted";
  }
}

export function lineageHasLiveMember(rootThreadId: string | SQLWrapper) {
  return sql<boolean>`EXISTS (SELECT 1 FROM threads member WHERE member.root_thread_id = ${rootThreadId} AND member.deleted_at IS NULL)`;
}

export function chatOwner(
  thread: { projectId: string; rootThreadId: string },
  work: { id: string; isNoWork: boolean },
): DraftOwner {
  return work.isNoWork
    ? { kind: "lineage", projectId: thread.projectId, rootThreadId: thread.rootThreadId }
    : { kind: "work", workId: work.id };
}

export function draftOwnerSql(): {
  workId: SQL<string | null>;
  rootThreadId: SQL<string | null>;
  handle: SQL<string | null>;
} {
  const draftId = sql`${drafts}.${sql.identifier("id")}`;
  const workId = sql`${drafts}.${sql.identifier("work_id")}`;
  const lineageRoot = sql`(SELECT ot.id FROM threads ot WHERE ot.draft_id = ${draftId} AND ${workId} IS NULL LIMIT 1)`;
  return {
    workId: sql<string | null>`${workId}::text`,
    rootThreadId: sql<string | null>`${lineageRoot}`,
    handle: sql<string | null>`COALESCE(
      (SELECT ow.handle FROM works ow WHERE ow.id = ${workId}),
      (SELECT ot.ref FROM threads ot WHERE ot.id = ${lineageRoot})
    )`,
  };
}

export function workDefaultDraftSql(): SQL<DraftId | null> {
  return sql<DraftId | null>`(SELECT dd.id FROM drafts dd
    WHERE dd.work_id = ${works}.${sql.identifier("id")} AND dd.is_default)`;
}

export function ownerOfColumns(columns: {
  projectId: string;
  workId: string | null;
  rootThreadId: string | null;
}): DraftOwner | null {
  if (columns.workId) return { kind: "work", workId: columns.workId };
  if (columns.rootThreadId)
    return { kind: "lineage", projectId: columns.projectId, rootThreadId: columns.rootThreadId };
  return null;
}

export function draftOfOwnerSql(owner: DraftOwner): SQL<string | null> {
  return owner.kind === "work"
    ? sql<
        string | null
      >`(SELECT d.id FROM drafts d WHERE d.work_id = ${owner.workId}::uuid AND d.is_default)`
    : sql<
        string | null
      >`(SELECT t.draft_id FROM threads t WHERE t.id = ${owner.rootThreadId} AND t.project_id = ${owner.projectId})`;
}

function lineageLockKey(rootThreadId: string): string {
  return `draft-owner:lineage:${rootThreadId}`;
}

export async function lockLineageOwners(
  db: DrizzleDb,
  rootThreadIds: readonly string[],
): Promise<ReadonlyMap<string, "active" | "frozen">> {
  const roots = [...new Set(rootThreadIds)].sort();
  const tx = currentDrizzleDb(db);
  for (const root of roots) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lineageLockKey(root)}, 0))`,
    );
  }
  return readLineageOwners(db, roots);
}

export async function readLineageOwners(
  db: DrizzleDb,
  rootThreadIds: readonly string[],
): Promise<ReadonlyMap<string, "active" | "frozen">> {
  const roots = [...new Set(rootThreadIds)].sort();
  const states = new Map<string, "active" | "frozen">();
  if (roots.length === 0) return states;
  const live = await currentDrizzleDb(db).execute<{ root: string; live: boolean }>(
    sql`SELECT r.id::text AS root, ${lineageHasLiveMember(sql`r.id`)} AS live
        FROM unnest(${sql`ARRAY[${sql.join(
          roots.map((root) => sql`${root}::uuid`),
          sql`, `,
        )}]`}) AS r(id)`,
  );
  for (const row of live) states.set(row.root, row.live ? "active" : "frozen");
  return states;
}

export async function lockLineagesOfThreads(
  db: DrizzleDb,
  threadIds: readonly string[],
  rootThreadIds: readonly string[] = [],
) {
  const roots = threadIds.length
    ? await currentDrizzleDb(db)
        .selectDistinct({ root: threads.rootThreadId })
        .from(threads)
        .where(inArray(threads.id, [...threadIds]))
    : [];
  await lockLineageOwners(db, [...roots.map((row) => row.root), ...rootThreadIds]);
}

export class LineageDraftsUnavailableError extends Error {
  constructor(readonly rootThreadId: string) {
    super("No chat in this lineage is live, so its draft takes no new writes");
    this.name = "LineageDraftsUnavailableError";
  }
}

export async function rootDraftFor(
  db: DrizzleDb,
  workId: string | null | undefined,
  requested: string | null | undefined,
): Promise<string | null> {
  if (!workId) return requested ?? null;
  const [row] = await currentDrizzleDb(db).execute<{
    no_work: boolean;
    named: string | null;
    fallback: string | null;
  }>(sql`
    SELECT w.is_no_work AS no_work,
      (SELECT d.id FROM drafts d WHERE d.work_id = w.id AND d.id = ${requested ?? null}
        AND d.deleted_at IS NULL) AS named,
      (SELECT d.id FROM drafts d WHERE d.work_id = w.id AND d.is_default) AS fallback
    FROM works w WHERE w.id = ${workId}::uuid`);
  if (!row || row.no_work) return requested ?? null;
  return row.named ?? row.fallback;
}

export async function carryRootDraft(
  db: DrizzleDb,
  threadId: string,
  workId: string,
): Promise<string[]> {
  const tx = currentDrizzleDb(db);
  const [row] = await tx.execute<{
    draft_id: string;
    draft_work: string | null;
    was_default: boolean;
    dest: string | null;
    project_id: string;
    created_by: string;
    shared: boolean;
  }>(sql`
    SELECT t.draft_id, d.work_id::text AS draft_work, d.is_default AS was_default,
      CASE WHEN w.is_no_work THEN NULL ELSE w.id::text END AS dest,
      t.project_id::text AS project_id, t.created_by_user_id::text AS created_by,
      EXISTS (SELECT 1 FROM threads o WHERE o.draft_id = t.draft_id AND o.id <> t.id) AS shared
    FROM threads t JOIN drafts d ON d.id = t.draft_id, works w
    WHERE t.id = ${threadId}::uuid AND t.root_thread_id = t.id AND w.id = ${workId}::uuid
    FOR NO KEY UPDATE OF d`);
  if (!row || row.draft_work === row.dest) return [];
  if (!row.shared) {
    await tx.execute(sql`
      UPDATE drafts SET work_id = ${row.dest}::uuid,
        is_default = ${row.dest}::uuid IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM drafts o WHERE o.work_id = ${row.dest}::uuid AND o.is_default)
      WHERE id = ${row.draft_id}`);
    if (row.draft_work && row.was_default)
      await tx.insert(drafts).values({
        id: newDraftId() as DraftId,
        projectId: row.project_id as ProjectId,
        workId: row.draft_work as WorkId,
        isDefault: true,
        createdBy: row.created_by as UserId,
      });
    return [row.draft_work, row.dest].filter((work) => work !== null);
  }
  let next: string | null = null;
  if (row.dest) {
    const [found] = await tx
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.workId, row.dest as WorkId), eq(drafts.isDefault, true)));
    next = found?.id ?? null;
  } else {
    next = newDraftId();
    await tx.insert(drafts).values({
      id: next as DraftId,
      projectId: row.project_id as ProjectId,
      createdBy: row.created_by as UserId,
    });
  }
  if (next)
    await tx
      .update(threads)
      .set({ draftId: next as DraftId })
      .where(eq(threads.id, threadId as ThreadId));
  return [];
}
