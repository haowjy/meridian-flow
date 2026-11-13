/**
 * The tree's rows, written from the list in the transaction that admitted its records
 * (`tree_nodes` for live, `branch_tree_nodes` for each open Work's view). Only this module
 * writes them: it replays live and each view the records can change, compares with what the
 * last replay wrote, and writes the rows that differ with the history text derivations need.
 */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import { filetypeForMimeType } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  branchTreeNodes,
  contextSources,
  documentDrafts,
  documents,
  treeNodeIds,
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
  replayView,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";
import { and, eq, inArray, sql } from "drizzle-orm";
import type * as Y from "yjs";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { isUuid } from "../../../shared/uuid.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { recordLocationHistory } from "../tree/node-locations.js";
import { keptBranches, projectOfList } from "./tree-list-facts.js";

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
 * The rows a replay shows. A purged node is gone for good: it has no row. A file's row is a
 * document's, typed by its blob's mime (the package leaves a file's type null).
 */
function shownRows(projection: TreeProjection): Map<string, ProjectedRow> {
  const rows = projectedRows(projection);
  for (const node of projection.nodes.values()) {
    const row = rows.get(node.id);
    if (node.purged) rows.delete(node.id);
    else if (row && node.kind === "file")
      row.filetype = filetypeForMimeType(node.blob?.mime ?? "application/octet-stream");
  }
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
/** Each node's source (its top folder's) and its path from that source's top. */
function addresses(
  rows: ReadonlyMap<string, ProjectedRow>,
): Map<string, { source: string; path: string }> {
  const memo = new Map<string, { source: string; path: string }>();
  const addressOf = (row: ProjectedRow): { source: string; path: string } => {
    const known = memo.get(row.id);
    if (known) return known;
    const parent = row.parentId === null ? undefined : rows.get(row.parentId);
    const address = parent
      ? { source: addressOf(parent).source, path: `${addressOf(parent).path}/${row.name}` }
      : { source: row.sourceId, path: row.name };
    memo.set(row.id, address);
    return address;
  };
  for (const row of rows.values()) addressOf(row);
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

/** An admitted `create`'s node id is refused: another node, a document or a list has it. */
export class NodeIdRefusedError extends Error {}

/**
 * Claims the node ids the records create, in the admitting transaction: the claim table's key is
 * the claim, so two lists that admit one id at once cannot both hold it. An id a document or a
 * list's journal already has is taken too. A document's own journal does not count: an import
 * writes each text under the id its create will have, before the create.
 */
export async function claimNodeIds(
  tx: DrizzleDb,
  listId: string,
  records: readonly TreeRecord[],
): Promise<void> {
  const ids = records.flatMap((record) => (record.type === "create" ? [record.node] : []));
  if (ids.length === 0) return;
  if (!ids.every(isUuid)) throw new NodeIdRefusedError("a node id that is not a uuid");
  const claimed = [];
  for (const batch of chunks(ids))
    claimed.push(
      ...(await tx
        .insert(treeNodeIds)
        .values(batch.map((id) => ({ id: id as DocumentId, listId: listId as DocumentId })))
        .onConflictDoNothing({ target: treeNodeIds.id })
        .returning({ id: treeNodeIds.id })),
    );
  if (claimed.length !== ids.length) throw new NodeIdRefusedError("a node id already in use");
  for (const batch of chunks(ids)) {
    const list = sql.join(
      batch.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const used = await tx.execute(sql`
      SELECT 1 FROM documents WHERE id IN (${list})
      UNION ALL SELECT 1 FROM document_yjs_heads WHERE kind = 'tree_list' AND document_id IN (${list}) LIMIT 1`);
    if (used.length > 0) throw new NodeIdRefusedError("a node id already in use");
  }
}

/**
 * Moves the claims of nodes that arrived from another list to this one, with their documents'
 * project (an account's list is its personal project's). The list they left has written its
 * rows already, so no row stands on the old claim.
 */
export async function arriveNodes(
  tx: DrizzleDb,
  list: TreeList,
  listId: string,
  ids: ReadonlySet<string>,
): Promise<void> {
  if (ids.size === 0) return;
  const nodes = sql.join(
    [...ids].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`UPDATE tree_node_ids SET list_id = ${listId}::uuid WHERE id IN (${nodes})`);
  await tx.execute(
    sql`UPDATE documents SET project_id = ${await projectOfList(tx, list)}::uuid WHERE id IN (${nodes})`,
  );
}

/**
 * A document or file made by an admitted `create` has its `documents` row from the same
 * transaction, drafted or live: its drafts, receipts and links point at it by foreign key. A
 * file's bytes are the record's blob. A node that no view shows has no row.
 */
async function insertDocumentRows(
  tx: DrizzleDb,
  projectId: string,
  records: readonly TreeRecord[],
  shown: (id: string) => boolean,
): Promise<void> {
  const created = records.flatMap((record) =>
    record.type === "create" && record.kind !== "folder" && shown(record.node) ? [record] : [],
  );
  for (const batch of chunks(created))
    await tx.insert(documents).values(
      batch.map((record) => ({
        id: record.node as DocumentId,
        projectId: projectId as ProjectId,
        ...(record.blob
          ? {
              storageUrl: record.blob.storageKey,
              mimeType: record.blob.mime,
              sizeBytes: record.blob.size,
            }
          : {}),
      })),
    );
}

async function writeLive(
  tx: DrizzleDb,
  listId: string,
  next: ReadonlyMap<string, ProjectedRow>,
  trash: ReadonlyMap<string, string>,
): Promise<string[]> {
  const prev = await loadLive(tx, listId);
  // The delete in force of each node the replay shows in Trash.
  const trashOf = (id: string) => (next.get(id)?.deleted ? (trash.get(id) ?? null) : null);
  const { upserts, gone } = changedRows(prev, next);
  const retrashed = [...next.keys()].filter(
    (id) => prev.has(id) && (prev.get(id)?.trashRecord ?? null) !== trashOf(id),
  );
  if (upserts.length === 0 && gone.length === 0 && retrashed.length === 0) return [];

  const was = addresses(prev);
  const now = addresses(next);
  const moved = (id: string) =>
    was.get(id)?.path !== now.get(id)?.path ||
    was.get(id)?.source !== now.get(id)?.source ||
    prev.get(id)?.deleted !== next.get(id)?.deleted;
  // A node whose address (its source included) or Trash state changed has a new version, and so
  // has everything under a folder that moved or was renamed: it is the address text derivations
  // compare.
  const bumped = [...next.keys()].filter((id) => prev.has(id) && moved(id));
  const bumpedIds = new Set(bumped);
  const changed = new Map(upserts.map((row) => [row.id, row]));
  for (const id of [...bumpedIds, ...retrashed]) {
    const row = next.get(id);
    if (row) changed.set(id, row);
  }

  const values = [...changed.values()].map((row) => {
    const before = prev.get(row.id);
    const trashRecord = trashOf(row.id);
    return {
      ...columnsOf(row),
      listId,
      locationVersion: (before?.version ?? 0n) + (bumpedIds.has(row.id) ? 1n : 0n),
      trashRecord,
      // When the server admitted that delete: kept while the same delete is in force.
      trashedAt:
        trashRecord === null
          ? null
          : before?.trashRecord === trashRecord
            ? before.trashedAt
            : new Date(),
    };
  });
  for (const batch of chunks(values))
    await tx
      .insert(treeNodes)
      .values(batch)
      .onConflictDoUpdate({
        target: treeNodes.id,
        set: {
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
    const path = (now.get(id) as { path: string }).path;
    if (before && !before.deleted && was.get(id)?.path === path && before.sourceId === row.sourceId)
      continue;
    claimed.push({ contextSourceId: row.sourceId, path });
    if (before && !before.deleted)
      vacated.push({
        contextSourceId: before.sourceId,
        path: (was.get(id) as { path: string }).path,
        documentId: id,
      });
  }
  if (vacated.length > 0 || claimed.length > 0)
    await recordLocationHistory(tx as unknown as Database, { vacated, claimed });
  return [...changed.keys(), ...gone];
}

async function writeBranch(
  tx: DrizzleDb,
  listId: string,
  branchId: string,
  prev: ReadonlyMap<string, BranchRow>,
  next: ReadonlyMap<string, BranchRow>,
): Promise<string[]> {
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
  return [...upserts.map((row) => row.id), ...gone];
}

/**
 * Nodes under a source whose row is gone (a purged Work's) have no row: a source's end is its
 * row's, and an ended source's nodes are not shown. Drops them from the views' rows.
 */
async function dropEndedSources(
  tx: DrizzleDb,
  views: readonly Map<string, ProjectedRow>[],
): Promise<void> {
  const sources = new Set(views.flatMap((rows) => [...rows.values()].map((row) => row.sourceId)));
  if (sources.size === 0) return;
  const present = await tx
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(inArray(contextSources.id, [...sources]));
  const kept = new Set(present.map((row) => row.id as string));
  for (const rows of views)
    for (const [id, row] of rows) if (!kept.has(row.sourceId)) rows.delete(id);
}

/**
 * Keeps `documents.in_no_view_since` true to the rows: null while a view shows the document (a
 * node row in live or in a Work's tree), the time it left the last view otherwise. Retention
 * purges a document that has been in no view for the window (a Discard offers Undo, so its text
 * waits).
 */
async function markUnviewed(tx: DrizzleDb, ids: readonly string[]): Promise<void> {
  for (const batch of chunks([...new Set(ids)])) {
    const list = sql.join(
      batch.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE documents d SET in_no_view_since = v.since
      FROM (
        SELECT d2.id, CASE WHEN EXISTS (SELECT 1 FROM tree_nodes t WHERE t.id = d2.id)
            OR EXISTS (SELECT 1 FROM branch_tree_nodes b WHERE b.id = d2.id)
          THEN NULL ELSE coalesce(d2.in_no_view_since, now()) END AS since
        FROM documents d2 WHERE d2.id IN (${list})
      ) v
      WHERE d.id = v.id AND d.in_no_view_since IS DISTINCT FROM v.since`);
  }
}

/**
 * Brings the rows to the list's replay: `added` are the records this transaction admitted, whose
 * documents get their `documents` rows. Call under the list's lock, after the update is
 * journaled, so the rows are never behind the list. The views replayed are live and every open
 * Work with pending tree records or pending text.
 */
export async function syncRows(
  db: DrizzleDb,
  list: TreeList,
  listId: string,
  doc: Y.Doc,
  added: readonly TreeRecord[],
): Promise<void> {
  const tx = currentDrizzleDb(db as Database);
  const live = replayView(doc, LIVE);
  const liveRows = shownRows(live);

  const kept = [...(await keptBranches(tx, list))];
  const text = await pendingText(tx, kept);
  const drafted = new Map<string, Map<string, ProjectedRow>>();
  for (const branchId of kept)
    if (text.has(branchId) || pendingRecords(doc, branchId).length > 0)
      drafted.set(branchId, shownRows(replayView(doc, { draft: branchId }, text.get(branchId))));
  await dropEndedSources(tx, [liveRows, ...drafted.values()]);
  const next = new Map(
    [...drafted].map(([branchId, rows]) => [branchId, branchRows(liveRows, rows)] as const),
  );

  if (added.length > 0)
    await insertDocumentRows(
      tx,
      await projectOfList(tx, list),
      added,
      (id) => liveRows.has(id) || [...next.values()].some((view) => view.has(id)),
    );
  const changed = await writeLive(tx, listId, liveRows, trashRecords(live));
  await testHook("treeList.afterLiveRows");

  const prev = await loadBranches(tx, listId);
  for (const branchId of new Set([...prev.keys(), ...next.keys()]))
    changed.push(
      ...(await writeBranch(
        tx,
        listId,
        branchId,
        prev.get(branchId) ?? new Map(),
        next.get(branchId) ?? new Map(),
      )),
    );
  await markUnviewed(tx, changed);
}
