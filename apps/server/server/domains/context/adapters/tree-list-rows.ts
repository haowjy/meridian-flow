/**
 * The tree's rows, written from the list in the transaction that admitted its records
 * (`tree_nodes` for live, `branch_tree_nodes` for each open Work's view). Only this module
 * writes them: it replays live and each view the records can change, compares with what the
 * last replay wrote, and writes the rows that differ with the history text derivations need.
 */
import { DEFAULT_FILETYPE } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  branches,
  branchTreeNodes,
  documentDrafts,
  documents,
  treeNodes,
} from "@meridian/database/schema";
import {
  type BranchRow,
  branchRows,
  changedRows,
  LIVE,
  type ProjectedRow,
  pendingRecords,
  projectedRows,
  recordsOf,
  replayView,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";
import { and, eq, inArray, sql } from "drizzle-orm";
import type * as Y from "yjs";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { isUuid } from "../../../shared/uuid.js";
import { recordLocationHistory } from "../tree/node-locations.js";

/** Rows per statement: bounds the parameter count, not the atomic operation. */
const BATCH = 500;

type LiveRow = ProjectedRow & {
  version: bigint;
  trashRecord: string | null;
  trashedAt: Date | null;
};

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += BATCH) out.push(items.slice(at, at + BATCH));
  return out;
}

/**
 * The rows a replay shows. A purged node is gone for good: it has no row. A document made with
 * no type is a default one, here and not in each reader.
 */
function shownRows(projection: TreeProjection): Map<string, ProjectedRow> {
  const rows = projectedRows(projection);
  for (const node of projection.nodes.values()) if (node.purged) rows.delete(node.id);
  for (const row of rows.values())
    if (row.kind === "document" && row.filetype === null) row.filetype = DEFAULT_FILETYPE;
  return rows;
}

/** The delete that put each trashed node in Trash: the first in force that took it. */
function trashRecords(projection: TreeProjection): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of projection.trash)
    for (const id of [entry.node, ...entry.cascade]) if (!out.has(id)) out.set(id, entry.id);
  return out;
}

/** Where a node is: its source and the names above it, so a move of any ancestor shows. */
function addresses(rows: ReadonlyMap<string, ProjectedRow>): Map<string, string> {
  const memo = new Map<string, string>();
  const pathOf = (row: ProjectedRow): string => {
    const known = memo.get(row.id);
    if (known !== undefined) return known;
    const parent = row.parentId === null ? undefined : rows.get(row.parentId);
    const path = parent ? `${pathOf(parent)}/${row.name}` : row.name;
    memo.set(row.id, path);
    return path;
  };
  for (const row of rows.values()) pathOf(row);
  return memo;
}

const columnsOf = (row: ProjectedRow) => ({
  id: row.id,
  kind: row.kind,
  contextSourceId: row.sourceId,
  parentId: row.parentId,
  name: row.name,
  extension: row.extension,
  fileType: row.filetype,
  rank: row.rank,
});

async function loadLive(tx: DrizzleDb, listId: string): Promise<Map<string, LiveRow>> {
  const rows = await tx.select().from(treeNodes).where(eq(treeNodes.listId, listId));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: row.kind,
        parentId: row.parentId,
        sourceId: row.contextSourceId,
        name: row.name,
        extension: row.extension,
        filetype: row.fileType,
        rank: row.rank,
        deleted: row.trashRecord !== null,
        version: row.locationVersion,
        trashRecord: row.trashRecord,
        trashedAt: row.trashedAt,
      },
    ]),
  );
}

async function loadBranches(
  tx: DrizzleDb,
  listId: string,
): Promise<Map<string, Map<string, BranchRow>>> {
  const rows = await tx.select().from(branchTreeNodes).where(eq(branchTreeNodes.listId, listId));
  const out = new Map<string, Map<string, BranchRow>>();
  for (const row of rows) {
    const byNode = out.get(row.branchId) ?? new Map<string, BranchRow>();
    byNode.set(row.id, {
      id: row.id,
      kind: row.kind,
      parentId: row.parentId,
      sourceId: row.contextSourceId,
      name: row.name,
      extension: row.extension,
      filetype: row.fileType,
      rank: row.rank,
      deleted: row.deleted,
      existsOnlyInDraft: row.existsOnlyInDraft,
    });
    out.set(row.branchId, byNode);
  }
  return out;
}

/** The Works whose view the list can show: open, with pending records of theirs in the list. */
async function openDrafts(tx: DrizzleDb, doc: Y.Doc): Promise<string[]> {
  const named = new Set<string>();
  for (const record of recordsOf(doc).toArray())
    if (record.draft !== null && isUuid(record.draft)) named.add(record.draft);
  if (named.size === 0) return [];
  const open = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(inArray(branches.id, [...named]), eq(branches.status, "active")));
  return open.map((row) => row.id).filter((id) => pendingRecords(doc, id).length > 0);
}

/** Documents a Work holds a pending text draft of, which the list cannot see (rule 7). */
async function pendingText(tx: DrizzleDb, drafts: readonly string[]) {
  const out = new Map<string, Set<string>>();
  if (drafts.length === 0) return out;
  const rows = await tx
    .select({ branchId: documentDrafts.branchId, documentId: documentDrafts.documentId })
    .from(documentDrafts)
    .where(
      and(
        inArray(documentDrafts.branchId, [...drafts]),
        eq(documentDrafts.kind, "work_draft"),
        eq(documentDrafts.status, "active"),
      ),
    );
  for (const row of rows)
    out.set(row.branchId, (out.get(row.branchId) ?? new Set<string>()).add(row.documentId));
  return out;
}

/**
 * A document made by an admitted `create` has its `documents` row from the same transaction,
 * drafted or live: its drafts, receipts and links point at it by foreign key.
 */
async function insertDocumentRows(tx: DrizzleDb, records: readonly TreeRecord[]): Promise<void> {
  const created = records.flatMap((record) =>
    record.type === "create" && record.kind === "document" ? [record] : [],
  );
  for (const batch of chunks(created))
    await tx
      .insert(documents)
      .values(
        batch.map((record) => ({
          id: record.node,
          contextSourceId: record.source,
          name: record.name,
          fileType: record.filetype ?? DEFAULT_FILETYPE,
        })),
      )
      .onConflictDoNothing({ target: documents.id });
}

async function writeLive(
  tx: DrizzleDb,
  listId: string,
  next: ReadonlyMap<string, ProjectedRow>,
  trash: ReadonlyMap<string, string>,
): Promise<void> {
  const prev = await loadLive(tx, listId);
  const { upserts, gone } = changedRows(prev, next);
  if (upserts.length === 0 && gone.length === 0) return;

  const was = addresses(prev);
  const now = addresses(next);
  const moved = (id: string) =>
    was.get(id) !== now.get(id) || prev.get(id)?.deleted !== next.get(id)?.deleted;
  // A node whose address or Trash state changed has a new version, and so has everything under a
  // folder that moved or was renamed: it is the address text derivations compare.
  const bumped = [...next.keys()].filter((id) => prev.has(id) && moved(id));
  const bumpedIds = new Set(bumped);
  const changed = new Map(upserts.map((row) => [row.id, row]));
  for (const id of bumpedIds) {
    const row = next.get(id);
    if (row) changed.set(id, row);
  }

  const values = [...changed.values()].map((row) => {
    const before = prev.get(row.id);
    const trashed = row.deleted;
    const kept = trashed && before?.trashRecord ? before : null;
    return {
      ...columnsOf(row),
      listId,
      locationVersion: (before?.version ?? 0n) + (bumpedIds.has(row.id) ? 1n : 0n),
      trashRecord: trashed ? (kept?.trashRecord ?? trash.get(row.id) ?? null) : null,
      trashedAt: trashed ? (kept?.trashedAt ?? new Date()) : null,
    };
  });
  for (const batch of chunks(values))
    await tx
      .insert(treeNodes)
      .values(batch)
      .onConflictDoUpdate({
        target: treeNodes.id,
        set: {
          listId: sql`excluded.list_id`,
          kind: sql`excluded.kind`,
          contextSourceId: sql`excluded.context_source_id`,
          parentId: sql`excluded.parent_id`,
          name: sql`excluded.name`,
          extension: sql`excluded.extension`,
          fileType: sql`excluded.file_type`,
          rank: sql`excluded.rank`,
          locationVersion: sql`excluded.location_version`,
          trashRecord: sql`excluded.trash_record`,
          trashedAt: sql`excluded.trashed_at`,
        },
      });
  for (const batch of chunks(gone))
    await tx
      .delete(treeNodes)
      .where(and(eq(treeNodes.listId, listId), inArray(treeNodes.id, batch)));

  // A document shown at one address and now at another leaves its old path as an alias; every
  // address a document now shows at claims it (a swap, a renumber).
  const vacated: { contextSourceId: string; path: string; documentId: string }[] = [];
  const claimed: { contextSourceId: string; path: string }[] = [];
  for (const [id, row] of next) {
    if (row.kind !== "document" || row.deleted) continue;
    const before = prev.get(id);
    const path = now.get(id) as string;
    if (before && !before.deleted && was.get(id) === path && before.sourceId === row.sourceId)
      continue;
    claimed.push({ contextSourceId: row.sourceId, path });
    if (before && !before.deleted)
      vacated.push({
        contextSourceId: before.sourceId,
        path: was.get(id) as string,
        documentId: id,
      });
  }
  if (vacated.length > 0 || claimed.length > 0)
    await recordLocationHistory(tx as unknown as Database, { vacated, claimed });
}

async function writeBranch(
  tx: DrizzleDb,
  listId: string,
  branchId: string,
  prev: ReadonlyMap<string, BranchRow>,
  next: ReadonlyMap<string, BranchRow>,
): Promise<void> {
  const { upserts, gone } = changedRows(prev, next);
  for (const batch of chunks(upserts))
    await tx
      .insert(branchTreeNodes)
      .values(
        batch.map((row) => ({
          ...columnsOf(row),
          branchId,
          listId,
          deleted: row.deleted,
          existsOnlyInDraft: row.existsOnlyInDraft,
        })),
      )
      .onConflictDoUpdate({
        target: [branchTreeNodes.branchId, branchTreeNodes.id],
        set: {
          listId: sql`excluded.list_id`,
          kind: sql`excluded.kind`,
          contextSourceId: sql`excluded.context_source_id`,
          parentId: sql`excluded.parent_id`,
          name: sql`excluded.name`,
          extension: sql`excluded.extension`,
          fileType: sql`excluded.file_type`,
          rank: sql`excluded.rank`,
          deleted: sql`excluded.deleted`,
          existsOnlyInDraft: sql`excluded.exists_only_in_draft`,
        },
      });
  for (const batch of chunks(gone))
    await tx
      .delete(branchTreeNodes)
      .where(
        and(
          eq(branchTreeNodes.listId, listId),
          eq(branchTreeNodes.branchId, branchId),
          inArray(branchTreeNodes.id, batch),
        ),
      );
}

/**
 * Brings the rows to the list's replay: `added` are the records this transaction admitted, whose
 * documents get their `documents` rows first. Call under the list's lock, after the update is
 * journaled, so the rows are never behind the list.
 */
export async function syncRows(
  db: DrizzleDb,
  listId: string,
  doc: Y.Doc,
  added: readonly TreeRecord[],
): Promise<void> {
  const tx = currentDrizzleDb(db as Database);
  await insertDocumentRows(tx, added);
  const live = replayView(doc, LIVE);
  const liveRows = shownRows(live);
  await writeLive(tx, listId, liveRows, trashRecords(live));
  await testHook("treeList.afterLiveRows");

  const prev = await loadBranches(tx, listId);
  const drafts = await openDrafts(tx, doc);
  const text = await pendingText(tx, drafts);
  for (const branchId of new Set([...prev.keys(), ...drafts])) {
    const next = drafts.includes(branchId)
      ? branchRows(liveRows, shownRows(replayView(doc, { draft: branchId }, text.get(branchId))))
      : new Map<string, BranchRow>();
    await writeBranch(tx, listId, branchId, prev.get(branchId) ?? new Map(), next);
  }
}
