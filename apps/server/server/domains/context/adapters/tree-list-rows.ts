import type { DocumentId, ProjectId, UserId } from "@meridian/contracts";
import { entrySegment, filetypeForMimeType } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  draftTreeNodes,
  treeNodeIds,
  treeNodes,
  works,
} from "@meridian/database/schema";
import {
  type CreateRecord,
  changedFolders,
  changedRows,
  type DraftRow,
  deleteCovering,
  draftRows,
  LIVE,
  listRecords,
  type ProjectedRow,
  pendingRecords,
  projectedRows,
  replayView,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { LoroDoc } from "loro-crdt";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { isUuid } from "../../../shared/uuid.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { recordLocationHistory } from "../tree/node-locations.js";
import { pendingText } from "../tree/pending-documents.js";
import { ownerColumns, sourceOwnerProjectId } from "../tree/source-owner.js";
import { keptDrafts } from "./tree-list-facts.js";

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

function trashRecords(
  projection: TreeProjection,
  actors: ReadonlyMap<string, string>,
): Map<string, { record: string; by: string | null }> {
  const out = new Map<string, { record: string; by: string | null }>();
  for (const entry of projection.trash)
    for (const id of [entry.node, ...entry.cascade])
      if (deleteCovering(projection, id) === entry)
        out.set(id, { record: entry.id, by: actors.get(entry.from ?? entry.id) ?? null });
  return out;
}

function addresses(
  rows: ReadonlyMap<string, ProjectedRow>,
): Map<string, { source: string; path: string }> {
  const memo = new Map<string, { source: string; path: string }>();
  const addressOf = (row: ProjectedRow): { source: string; path: string } => {
    const known = memo.get(row.id);
    if (known) return known;
    const parent = row.parentId === null ? undefined : rows.get(row.parentId);
    const segment = entrySegment(row.name, row.suffix);
    const address = parent
      ? { source: addressOf(parent).source, path: `${addressOf(parent).path}/${segment}` }
      : { source: row.sourceId, path: segment };
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
  suffix: row.suffix,
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
        suffix: row.suffix,
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

async function loadDrafts(
  tx: DrizzleDb,
  listId: string,
): Promise<Map<string, Map<string, DraftRow>>> {
  const rows = await tx.select().from(draftTreeNodes).where(eq(draftTreeNodes.listId, listId));
  const out = new Map<string, Map<string, DraftRow>>();
  for (const row of rows) {
    const byNode = out.get(row.draftId) ?? new Map<string, DraftRow>();
    byNode.set(row.id, {
      id: row.id,
      kind: row.kind,
      parentId: row.parentId,
      sourceId: row.contextSourceId,
      name: row.name,
      suffix: row.suffix,
      extension: row.extension,
      filetype: row.fileType,
      rank: row.rank,
      deleted: row.deleted,
      existsOnlyInDraft: row.existsOnlyInDraft,
      changed: row.changed,
    });
    out.set(row.draftId, byNode);
  }
  return out;
}

export class NodeIdRefusedError extends Error {
  constructor(
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
  }
}

/**
 * Claims the node ids the records create, in the admitting transaction: the claim table's key is
 * the claim, so two lists that admit one id at once cannot both hold it. An id a document row or a
 * list already has is taken too. A document's Live room does not count: an import seeds each
 * text under the id its create will have, before the create.
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
  if (claimed.length !== ids.length) {
    const won = new Set(claimed.map((row) => row.id as string));
    throw new NodeIdRefusedError(
      "a node id already in use",
      ids.find((id) => !won.has(id)),
    );
  }
  for (const batch of chunks(ids)) {
    const list = sql.join(
      batch.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const used = await tx.execute(sql`
      SELECT id::text AS id FROM documents WHERE id IN (${list})
      UNION ALL SELECT tree_list_id::text FROM projects WHERE tree_list_id IN (${list})
      UNION ALL SELECT tree_list_id::text FROM users WHERE tree_list_id IN (${list}) LIMIT 1`);
    if (used.length > 0)
      throw new NodeIdRefusedError("a node id already in use", (used[0] as { id: string }).id);
  }
}

/**
 * Claims the node ids a client's creates name, each on its own: an id that is not a uuid, or that
 * a document, a list or another list's node already has, is a failed claim. No row is made for
 * it and the rest of the update stands: the node shows in its writer's own tree and opens
 * nothing, and nobody else's document is touched. Returns the node ids that failed.
 */
export async function claimNodeIdsEach(
  tx: DrizzleDb,
  listId: string,
  records: readonly TreeRecord[],
): Promise<Set<string>> {
  const ids = [
    ...new Set(records.flatMap((record) => (record.type === "create" ? [record.node] : []))),
  ];
  const failed = new Set(ids.filter((id) => !isUuid(id)));
  for (const batch of chunks(ids.filter(isUuid))) {
    const list = sql.join(
      batch.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const used = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM documents WHERE id IN (${list})
      UNION ALL SELECT tree_list_id::text FROM projects WHERE tree_list_id IN (${list})
      UNION ALL SELECT tree_list_id::text FROM users WHERE tree_list_id IN (${list})`);
    for (const row of used) failed.add(row.id);
    const open = batch.filter((id) => !failed.has(id));
    if (open.length === 0) continue;
    const won = await tx
      .insert(treeNodeIds)
      .values(open.map((id) => ({ id: id as DocumentId, listId: listId as DocumentId })))
      .onConflictDoNothing({ target: treeNodeIds.id })
      .returning({ id: treeNodeIds.id });
    const held = new Set(won.map((row) => row.id as string));
    for (const id of open) if (!held.has(id)) failed.add(id);
  }
  return failed;
}

async function dropUnowned(
  tx: DrizzleDb,
  listId: string,
  prev: ReadonlyMap<string, unknown>,
  next: Map<string, unknown>,
): Promise<void> {
  const fresh = [...next.keys()].filter((id) => !prev.has(id));
  const owned = new Set<string>();
  for (const batch of chunks(fresh.filter(isUuid)))
    for (const row of await tx
      .select({ id: treeNodeIds.id })
      .from(treeNodeIds)
      .where(and(eq(treeNodeIds.listId, listId), inArray(treeNodeIds.id, batch))))
      owned.add(row.id as string);
  for (const id of fresh) if (!owned.has(id)) next.delete(id);
}

async function insertDocumentRows(
  tx: DrizzleDb,
  owner: TreeList,
  records: readonly TreeRecord[],
  shown: (id: string) => boolean,
): Promise<CreateRecord[]> {
  const created = records.flatMap((record) =>
    record.type === "create" && record.kind !== "folder" && shown(record.node) ? [record] : [],
  );
  for (const batch of chunks(created))
    await tx.insert(documents).values(
      batch.map((record) => ({
        id: record.node as DocumentId,
        projectId: ownerColumns(owner).projectId as ProjectId | null,
        userId: ownerColumns(owner).userId as UserId | null,
        ...(record.blob
          ? {
              storageUrl: record.blob.storageKey,
              mimeType: record.blob.mime,
              sizeBytes: record.blob.size,
            }
          : {}),
      })),
    );
  return created;
}

async function writeLive(
  tx: DrizzleDb,
  listId: string,
  next: Map<string, ProjectedRow>,
  trash: ReadonlyMap<string, { record: string; by: string | null }>,
  made: ReadonlySet<string>,
): Promise<{ changed: string[]; reassigned: string[] }> {
  const prev = await loadLive(tx, listId);
  await dropUnowned(tx, listId, prev, next);
  const trashed = (id: string) => (next.get(id)?.deleted ? (trash.get(id) ?? null) : null);
  const trashOf = (id: string) => trashed(id)?.record ?? null;
  const { upserts, gone } = changedRows(prev, next);
  const retrashed = [...next.keys()].filter(
    (id) => prev.has(id) && (prev.get(id)?.trashRecord ?? null) !== trashOf(id),
  );
  if (upserts.length === 0 && gone.length === 0 && retrashed.length === 0)
    return { changed: [], reassigned: [] };

  const was = addresses(prev);
  const now = addresses(next);
  const moved = (id: string) =>
    was.get(id)?.path !== now.get(id)?.path ||
    was.get(id)?.source !== now.get(id)?.source ||
    prev.get(id)?.deleted !== next.get(id)?.deleted;
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
      trashedBy: trashed(row.id)?.by ?? null,
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
          suffix: sql`excluded.suffix`,
          extension: sql`excluded.extension`,
          fileType: sql`excluded.file_type`,
          rank: sql`excluded.rank`,
          locationVersion: sql`excluded.location_version`,
          trashRecord: sql`excluded.trash_record`,
          trashedAt: sql`excluded.trashed_at`,
          trashedBy: sql`excluded.trashed_by`,
        },
      });
  for (const batch of chunks(gone))
    await tx
      .delete(treeNodes)
      .where(and(eq(treeNodes.listId, listId), inArray(treeNodes.id, batch)));

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
  const reassigned = [...next].flatMap(([id, row]) =>
    row.kind === "document" &&
    (prev.has(id) ? was.get(id)?.source !== now.get(id)?.source : !made.has(id))
      ? [id]
      : [],
  );
  return { changed: [...changed.keys(), ...gone], reassigned };
}

async function writeDraft(
  tx: DrizzleDb,
  listId: string,
  draftId: string,
  prev: ReadonlyMap<string, DraftRow>,
  next: Map<string, DraftRow>,
): Promise<string[]> {
  await dropUnowned(tx, listId, prev, next);
  const { upserts, gone } = changedRows(prev, next);
  for (const batch of chunks(upserts))
    await tx
      .insert(draftTreeNodes)
      .values(
        batch.map((row) => ({
          ...columnsOf(row),
          draftId,
          listId,
          deleted: row.deleted,
          existsOnlyInDraft: row.existsOnlyInDraft,
          changed: row.changed,
        })),
      )
      .onConflictDoUpdate({
        target: [draftTreeNodes.draftId, draftTreeNodes.id],
        set: {
          kind: sql`excluded.kind`,
          contextSourceId: sql`excluded.context_source_id`,
          parentId: sql`excluded.parent_id`,
          name: sql`excluded.name`,
          suffix: sql`excluded.suffix`,
          extension: sql`excluded.extension`,
          fileType: sql`excluded.file_type`,
          rank: sql`excluded.rank`,
          deleted: sql`excluded.deleted`,
          existsOnlyInDraft: sql`excluded.exists_only_in_draft`,
          changed: sql`excluded.changed`,
        },
      });
  for (const batch of chunks(gone))
    await tx
      .delete(draftTreeNodes)
      .where(
        and(
          eq(draftTreeNodes.listId, listId),
          eq(draftTreeNodes.draftId, draftId),
          inArray(draftTreeNodes.id, batch),
        ),
      );
  return [...upserts.map((row) => row.id), ...gone];
}

async function dropForeignSources(
  tx: DrizzleDb,
  list: TreeList,
  views: readonly Map<string, ProjectedRow>[],
): Promise<void> {
  const sources = new Set(views.flatMap((rows) => [...rows.values()].map((row) => row.sourceId)));
  if (sources.size === 0) return;
  const present = await tx
    .select({ id: contextSources.id })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(
      and(
        inArray(contextSources.id, [...sources]),
        list.kind === "project"
          ? sql`${sourceOwnerProjectId} = ${list.projectId}::uuid`
          : eq(contextSources.userId, list.userId as UserId),
      ),
    );
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
            OR EXISTS (SELECT 1 FROM draft_tree_nodes b WHERE b.id = d2.id)
          THEN NULL ELSE coalesce(d2.in_no_view_since, now()) END AS since
        FROM documents d2 WHERE d2.id IN (${list})
      ) v
      WHERE d.id = v.id AND d.in_no_view_since IS DISTINCT FROM v.since`);
  }
}

/**
 * Brings the rows to the list's replay: `added` are the records this transaction admitted, whose
 * documents get their `documents` rows. Call under the list's lock, after the update is
 * in the list, so the rows are never behind the list. The views replayed are live and every open
 * Work with pending tree records or pending text. Returns the creates that made a document row,
 * and the Works' drafts whose rows changed (their review count may have moved).
 */
export async function syncRows(
  db: DrizzleDb,
  list: TreeList,
  listId: string,
  doc: LoroDoc,
  added: readonly TreeRecord[],
): Promise<{
  created: CreateRecord[];
  changedDrafts: string[];
  liveChangedUnder: string[];
  reassigned: string[];
}> {
  const tx = currentDrizzleDb(db as Database);
  const live = replayView(doc, LIVE);
  const liveRows = shownRows(live);

  const kept = [...(await keptDrafts(tx, list))];
  const works = new Map<
    string,
    { rows: Map<string, ProjectedRow>; faulted: Set<string>; pending: TreeRecord[] }
  >();
  for (const draftId of kept) {
    const pending = pendingRecords(doc, draftId);
    if (pending.length === 0) continue;
    const projection = replayView(doc, { draft: draftId });
    works.set(draftId, {
      rows: shownRows(projection),
      faulted: changedFolders(live, projection, pending),
      pending,
    });
  }
  await dropForeignSources(tx, list, [liveRows, ...[...works.values()].map((work) => work.rows)]);
  const next = new Map(
    [...works].map(([draftId, { rows, faulted, pending }]) => {
      const differing = draftRows(liveRows, rows, pending);
      for (const id of faulted) {
        const row = rows.get(id);
        if (row && !differing.get(id)?.changed)
          differing.set(id, { ...row, existsOnlyInDraft: false, changed: true });
      }
      return [draftId, differing] as const;
    }),
  );

  const created =
    added.length > 0
      ? await insertDocumentRows(
          tx,
          list,
          added,
          (id) => liveRows.has(id) || [...next.values()].some((view) => view.has(id)),
        )
      : [];
  const actors = new Map(listRecords(doc).map((record) => [record.id, record.actor]));
  const { changed, reassigned } = await writeLive(
    tx,
    listId,
    liveRows,
    trashRecords(live, actors),
    new Set(created.map((record) => record.node)),
  );
  await testHook("treeList.afterLiveRows");

  const prev = await loadDrafts(tx, listId);
  // A draft row reads live's rows on its node and its parent (a move's place),
  // so a live change there changes the owner's list even when the draft's own rows don't.
  // `writeLive` names every node under a changed folder, so the parent covers deeper folders.
  const liveIds = new Set(changed);
  const liveChangedUnder = [...new Set([...prev.keys(), ...next.keys()])].filter((draftId) =>
    [prev.get(draftId), next.get(draftId)].some(
      (rows) =>
        rows &&
        [...rows].some(
          ([id, row]) => liveIds.has(id) || (row.parentId !== null && liveIds.has(row.parentId)),
        ),
    ),
  );
  // A live change to a document a draft has pending text in changes the Work's list (a move's place),
  // and a trash or restore its count, though the Work has no row there.
  const holding = await draftsWithText(tx, kept, [...liveIds].filter(isUuid));
  const changedDrafts: string[] = [...holding];
  liveChangedUnder.push(...holding.filter((draftId) => !liveChangedUnder.includes(draftId)));
  for (const draftId of new Set([...prev.keys(), ...next.keys()])) {
    const written = await writeDraft(
      tx,
      listId,
      draftId,
      prev.get(draftId) ?? new Map(),
      next.get(draftId) ?? new Map(),
    );
    if (written.length > 0) changedDrafts.push(draftId);
    changed.push(...written);
  }
  await markUnviewed(tx, changed);
  return { created, changedDrafts: [...new Set(changedDrafts)], liveChangedUnder, reassigned };
}

async function draftsWithText(
  tx: DrizzleDb,
  kept: readonly string[],
  documentIds: readonly string[],
): Promise<string[]> {
  if (kept.length === 0 || documentIds.length === 0) return [];
  const list = (ids: readonly string[]) =>
    sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
  const documents = sql.join(
    documentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await tx.execute<{ draft_id: string }>(sql`
    SELECT DISTINCT text.draft_id AS draft_id
    FROM (${pendingText(list(kept))}) text
    WHERE text.document_id IN (${documents})`);
  return rows.map((row) => row.draft_id);
}
