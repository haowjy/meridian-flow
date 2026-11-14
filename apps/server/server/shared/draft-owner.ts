/**
 * Who owns a branch and whether its drafts can be written: the one reader of a branch's owner,
 * its handle and its lifecycle, and the lock that serializes a lineage's writes. A branch is
 * owned by a Work or by a conversation lineage, never both. Every reader that needs the owner
 * of a branch goes through `branchOwnerSql`, so a lineage branch (null `origin_work_id`) can't
 * be mistaken for a purged Work's.
 */
import {
  type BranchId,
  type DraftOwner,
  type DraftOwnerKey,
  draftOwnerKey,
} from "@meridian/contracts";
import { branches, documentDrafts, threads } from "@meridian/database/schema";
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

export type BranchOwnerLifecycle = "active" | "archived" | "frozen" | "deleted" | "missing";

/** Identity is independent of availability: a trashed first chat can have live forks. */
export function lineageHasLiveMember(rootThreadId: string | SQLWrapper) {
  return sql<boolean>`EXISTS (SELECT 1 FROM threads member WHERE member.root_thread_id = ${rootThreadId} AND member.deleted_at IS NULL)`;
}

/**
 * Who owns a chat's drafts: its named Work, or its conversation lineage when it has no Work.
 * Scratch follows the same rule (`scratchOwnerFor`), so the two can't disagree about whose
 * material a chat writes.
 */
export function chatOwner(
  thread: { projectId: string; rootThreadId: string },
  work: { id: string; isNoWork: boolean },
): DraftOwner {
  return work.isNoWork
    ? { kind: "lineage", projectId: thread.projectId, rootThreadId: thread.rootThreadId }
    : { kind: "work", workId: work.id };
}

type BranchColumns = { workId: SQLWrapper; rootThreadId: SQLWrapper };

/**
 * The owner columns, handle and lifecycle of a branch row as SQL. Pass the drizzle `branches`
 * table, or the alias of a raw-SQL branch row. `lifecycle` is `active`, `archived` (a Work),
 * `frozen` (a lineage with no live member), `deleted`, or `missing` (a closed branch whose
 * owner is gone).
 */
export function branchOwnerSql(from: typeof branches | string): {
  workId: SQL<string | null>;
  rootThreadId: SQL<string | null>;
  handle: SQL<string | null>;
  lifecycle: SQL<BranchOwnerLifecycle>;
} {
  const columns: BranchColumns =
    typeof from === "string"
      ? {
          workId: sql.raw(`${from}.origin_work_id`),
          rootThreadId: sql.raw(`${from}.origin_root_thread_id`),
        }
      : { workId: from.originWorkId, rootThreadId: from.originRootThreadId };
  return {
    workId: sql<string | null>`${columns.workId}`,
    rootThreadId: sql<string | null>`${columns.rootThreadId}`,
    handle: sql<string | null>`CASE
      WHEN ${columns.workId} IS NOT NULL THEN (SELECT ow.handle FROM works ow WHERE ow.id = ${columns.workId})
      WHEN ${columns.rootThreadId} IS NOT NULL THEN (SELECT ot.ref FROM threads ot WHERE ot.id = ${columns.rootThreadId})
    END`,
    lifecycle: sql<BranchOwnerLifecycle>`CASE
      WHEN ${columns.workId} IS NOT NULL THEN coalesce((SELECT CASE
        WHEN ow.deleted_at IS NOT NULL THEN 'deleted'
        WHEN ow.archived_at IS NOT NULL THEN 'archived'
        ELSE 'active' END FROM works ow WHERE ow.id = ${columns.workId}), 'missing')
      WHEN ${columns.rootThreadId} IS NOT NULL THEN
        CASE WHEN ${lineageHasLiveMember(sql`${columns.rootThreadId}`)} THEN 'active' ELSE 'frozen' END
      ELSE 'missing'
    END`,
  };
}

/** The owner key a branch's owner columns name; null for a closed branch with no owner. */
export function ownerKeyOfColumns(columns: {
  workId: string | null;
  rootThreadId: string | null;
}): DraftOwnerKey | null {
  if (columns.workId) return draftOwnerKey({ kind: "work", workId: columns.workId });
  if (columns.rootThreadId)
    return draftOwnerKey({ kind: "lineage", rootThreadId: columns.rootThreadId });
  return null;
}

/** The owner a branch's (or draft's) owner columns name; null for a closed branch with no owner. */
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

/** The `branches` rows this owner owns. */
export function branchOwnedBy(owner: DraftOwner): SQL {
  return owner.kind === "work"
    ? eq(branches.originWorkId, owner.workId)
    : (and(
        eq(branches.originRootThreadId, owner.rootThreadId),
        eq(branches.projectId, owner.projectId),
      ) as SQL);
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
  const states = new Map<string, "active" | "frozen">();
  if (roots.length === 0) return states;
  const tx = currentDrizzleDb(db);
  for (const root of roots) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lineageLockKey(root)}, 0))`,
    );
  }
  const live = await tx.execute<{ root: string; live: boolean }>(
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

export type BranchDraftRef = {
  id: string;
  branchId: BranchId;
  workId: string | null;
  rootThreadId: string | null;
};

/** The named drafts that exist, each with its branch and that branch's owner columns. */
export async function branchDraftRefs(
  db: DrizzleDb,
  draftIds: readonly string[],
): Promise<BranchDraftRef[]> {
  if (draftIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({
      id: documentDrafts.id,
      branchId: documentDrafts.branchId,
      workId: branches.originWorkId,
      rootThreadId: branches.originRootThreadId,
    })
    .from(documentDrafts)
    .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
    .where(inArray(documentDrafts.id, [...new Set(draftIds)]));
  return rows;
}
