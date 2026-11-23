/**
 * Whose material a chat writes (`chatOwner`), which draft an owner names, who owns a draft, and
 * the lock that serializes a lineage's writes. An owner is a Work or a conversation lineage. A
 * Work's drafts name it (`drafts.work_id`), one of them its default; a No Work lineage's draft is
 * the one its root chat names (`threads.draft_id`).
 */
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

/** Owners a write set names: Works by id, lineages by root thread id. */
export type OwnerLocks = { workIds: string[]; lineageRootIds: string[] };

/** The owners of every set together, each list sorted and without repeats. */
export function mergeOwnerLocks(...sets: readonly OwnerLocks[]): OwnerLocks {
  return {
    workIds: [...new Set(sets.flatMap((set) => set.workIds))].sort(),
    lineageRootIds: [...new Set(sets.flatMap((set) => set.lineageRootIds))].sort(),
  };
}

export type DraftOwnerLifecycle = "active" | "archived" | "frozen" | "deleted" | "missing";

/** Why a draft's owner is closed to writes, or null while it is active. */
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

/** Identity is independent of availability: a trashed first chat can have live forks. */
export function lineageHasLiveMember(rootThreadId: string | SQLWrapper) {
  return sql<boolean>`EXISTS (SELECT 1 FROM threads member WHERE member.root_thread_id = ${rootThreadId} AND member.deleted_at IS NULL)`;
}

/**
 * Whose material a chat writes: its named Work, or its conversation lineage when it has no Work.
 * Scratch follows this rule (`scratchOwnerFor`), and the chat drafts into the draft this owner
 * names (`draftOfOwnerSql`), so the two can't disagree.
 */
export function chatOwner(
  thread: { projectId: string; rootThreadId: string },
  work: { id: string; isNoWork: boolean },
): DraftOwner {
  return work.isNoWork
    ? { kind: "lineage", projectId: thread.projectId, rootThreadId: thread.rootThreadId }
    : { kind: "work", workId: work.id };
}

/**
 * Who owns a draft, as SQL over a query that reads `drafts`: its Work (`work_id`), or the root
 * chat whose lineage's draft it is, and the handle the writer knows it by (`w3`, `c12`).
 */
export function draftOwnerSql(): {
  workId: SQL<string | null>;
  rootThreadId: SQL<string | null>;
  handle: SQL<string | null>;
} {
  // Qualified by hand: Drizzle renders a lone table's column bare, which inside these subqueries
  // would name the subquery's own `id`.
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

/** A Work's default draft, as SQL over a query that reads `works`. */
export function workDefaultDraftSql(): SQL<DraftId | null> {
  return sql<DraftId | null>`(SELECT dd.id FROM drafts dd
    WHERE dd.work_id = ${works}.${sql.identifier("id")} AND dd.is_default)`;
}

/** The owner a draft's naming columns name; null when nothing names it any more. */
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

/** The draft an owner names, as SQL: its Work's default, or its lineage root's. */
export function draftOfOwnerSql(owner: DraftOwner): SQL<string | null> {
  return owner.kind === "work"
    ? sql<
        string | null
      >`(SELECT d.id FROM drafts d WHERE d.work_id = ${owner.workId}::uuid AND d.is_default)`
    : sql<
        string | null
      >`(SELECT t.draft_id FROM threads t WHERE t.id = ${owner.rootThreadId} AND t.project_id = ${owner.projectId})`;
}

/** The lock key of a lineage's drafts. */
function lineageLockKey(rootThreadId: string): string {
  return `draft-owner:lineage:${rootThreadId}`;
}

/**
 * Takes the lineages' draft-owner locks in root-id order, in the caller's transaction. They
 * go after the Work row locks and before any draft, namespace or document lock: the owner
 * slot of the global order. Returns each lineage's liveness under its lock.
 */
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

/** Each lineage's liveness as it stands, with no lock: a lineage with no live member is frozen. */
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

/**
 * Locks the lineages the given threads belong to, with `rootThreadIds` named outright, for a
 * transition that changes their liveness.
 */
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

/** A lineage's draft takes no new writes: no chat in it is live. */
export class LineageDraftsUnavailableError extends Error {
  constructor(readonly rootThreadId: string) {
    super("No chat in this lineage is live, so its draft takes no new writes");
    this.name = "LineageDraftsUnavailableError";
  }
}

/**
 * The draft a new root chat bound to `workId` names: `requested` while it is one of the Work's
 * drafts and not deleted, else the Work's default. With No Work (or no Work yet) the lineage has
 * its own, `requested` or minted by `mint_named_draft`.
 */
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

/**
 * A root chat bound to another Work carries its draft (design §2): when no other chat names the
 * draft, the draft moves (`drafts.work_id`), becoming the destination's default if it has none,
 * and a Work it leaves without a default gets a fresh one; when others name it, the chat names
 * the destination's default instead, or a fresh lineage draft with No Work. Nothing in a document
 * changes: a fork is named by its draft. A non-root chat writes its root's draft and has nothing
 * to carry. Call it in the binding's transaction, after the new primary row.
 */
export async function carryRootDraft(db: DrizzleDb, threadId: string, workId: string) {
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
    FOR UPDATE OF d`);
  if (!row || row.draft_work === row.dest) return;
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
    return;
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
}
