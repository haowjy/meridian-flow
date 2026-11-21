/**
 * Whose material a chat writes (`chatOwner`), which draft an owner names, who names a draft, and
 * the lock that serializes a lineage's writes. An owner is a Work or a conversation lineage; it
 * names its draft (`works.draft_id`, the root chat's `threads.draft_id`), and the draft names no
 * owner.
 */
import type { DraftOwner } from "@meridian/contracts";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import { threads } from "@meridian/database/schema";
import { inArray, type SQL, type SQLWrapper, sql } from "drizzle-orm";
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

export type BranchOwnerLifecycle = "active" | "archived" | "frozen" | "deleted" | "missing";

/** Why a branch's owner is closed to writes, or null while it is active. */
export function closedOwnerOf(lifecycle: BranchOwnerLifecycle): ClosedOwnerWhy | null {
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
 * Who names a draft, as SQL over a draft id expression: the Work whose `draft_id` it is, or the
 * root chat whose lineage it is, and the handle the writer knows it by (`w3`, `c12`). A draft
 * names no owner itself; this is the one reverse read, for labels and the AI-write lifecycle.
 */
export function draftOwnerSql(draftId: SQLWrapper): {
  workId: SQL<string | null>;
  rootThreadId: SQL<string | null>;
  handle: SQL<string | null>;
} {
  return {
    workId: sql<string | null>`(SELECT ow.id FROM works ow WHERE ow.draft_id = ${draftId})`,
    rootThreadId: sql<string | null>`(SELECT ot.id FROM threads ot WHERE ot.draft_id = ${draftId})`,
    handle: sql<string | null>`COALESCE(
      (SELECT ow.handle FROM works ow WHERE ow.draft_id = ${draftId}),
      (SELECT ot.ref FROM threads ot WHERE ot.draft_id = ${draftId})
    )`,
  };
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

/** The draft an owner names, as SQL: its Work's `draft_id`, or its lineage root's. */
export function draftOfOwnerSql(owner: DraftOwner): SQL<string | null> {
  return owner.kind === "work"
    ? sql<string | null>`(SELECT w.draft_id FROM works w WHERE w.id = ${owner.workId})`
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
 * go after the Work row locks and before any branch, namespace or document lock: the owner
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

/** A lineage's drafts can't be written: no chat in it is live. */
export class LineageDraftsUnavailableError extends Error {
  constructor(readonly rootThreadId: string) {
    super("Chat drafts are unavailable because no chat in their lineage is live");
    this.name = "LineageDraftsUnavailableError";
  }
}
