/**
 * Read-only snapshot of today's tree rows as operation records.
 * Writes nothing. Record ids are derived from the row id and the fact, so a second
 * run produces the same list.
 */
import { renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  branches,
  branchTreeChanges,
  branchTreeParentOrders,
  branchTreeRanks,
  contextSources,
  documentDrafts,
  documentEdits,
  documentPreviousLocations,
  documents,
  folders,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { isStorageBackedDocument } from "../../../context/adapters/catalog-file-mapper.js";
import {
  type Actor,
  type Settlement,
  sourceRoot,
  type TreeOp,
} from "./tree-log.js";

export type ActorSource = {
  kind: TreeOp["type"];
  column: string;
  fallback: "unrecorded";
};

/** Per kind of record, which column the actor came from. */
export const ACTOR_COLUMNS: Record<string, ActorSource> = {
  "create.folder": { kind: "create", column: "(none — folders have no creator)", fallback: "unrecorded" },
  "create.document.live": {
    kind: "create",
    column: "document_edits.actor + actor_user_id / thread_id+turn_id (tree_change.op=create)",
    fallback: "unrecorded",
  },
  "create.document.draft": {
    kind: "create",
    column: "branch_tree_changes.created_thread_id + created_turn_id",
    fallback: "unrecorded",
  },
  "delete.document": {
    kind: "delete",
    column: "documents.deleted_by_thread_id (+ turn from document_edits) or deleted_by_user_id",
    fallback: "unrecorded",
  },
  "delete.folder": {
    kind: "delete",
    column: "(none — folders.deleted_by_work_id is a Work, not an actor)",
    fallback: "unrecorded",
  },
  "move.draft": {
    kind: "move",
    column: "branch_tree_changes.changed_thread_id + changed_turn_id",
    fallback: "unrecorded",
  },
  "rename.draft": {
    kind: "rename",
    column: "branch_tree_changes.changed_thread_id + changed_turn_id",
    fallback: "unrecorded",
  },
};

export type UnrecordedFact = {
  fact: string;
  nodeId: string;
  reason: string;
};

export type MigrateResult = {
  records: TreeOp[];
  settled: Record<string, Settlement>;
  unrecorded: UnrecordedFact[];
  actorColumns: typeof ACTOR_COLUMNS;
  previousLocations: { contextSourceId: string; path: string; documentId: string }[];
  /** Documents each open branch holds a pending text draft of (`work_draft` + `has_effect`). */
  pendingText: Record<string, string[]>;
  counts: {
    liveCreates: number;
    liveDeletes: number;
    draftCreates: number;
    draftMoves: number;
    draftRenames: number;
    draftDeletes: number;
    draftRankMoves: number;
    unrecorded: number;
    pendingText: number;
    inventedRecords: number;
  };
};

type DocRow = typeof documents.$inferSelect;
type FolderRow = typeof folders.$inferSelect;
type SourceRow = typeof contextSources.$inferSelect;
type ChangeRow = typeof branchTreeChanges.$inferSelect;

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function actorOf(input: {
  threadId?: string | null;
  turnId?: string | null;
  userId?: string | null;
}): Actor {
  if (input.threadId && input.turnId) return `agent:${input.threadId}/${input.turnId}`;
  if (input.threadId) return `agent:${input.threadId}/`;
  if (input.userId) return `user:${input.userId}`;
  return "unrecorded";
}

function parentOf(sourceId: string, folderId: string | null): string {
  return folderId ?? sourceRoot(sourceId);
}

function filenameOf(row: { name: string; extension: string }): string {
  return renderFilename(row.name, row.extension);
}

function rankOf(rank: string | null | undefined): string {
  return rank ?? "";
}

function nodeKindOf(row: Pick<DocRow, "fileType" | "storageUrl">): "document" | "file" {
  return isStorageBackedDocument(row) ? "file" : "document";
}

function blobOf(row: DocRow) {
  if (!row.storageUrl) return undefined;
  return {
    storageKey: row.storageUrl,
    mime: row.mimeType ?? "application/octet-stream",
    size: row.sizeBytes ?? 0,
  };
}

function topoFolders(rows: FolderRow[]): FolderRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const out: FolderRow[] = [];
  const visit = (row: FolderRow) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (row.parentId && byId.has(row.parentId)) visit(byId.get(row.parentId) as FolderRow);
    out.push(row);
  };
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  for (const row of sorted) visit(row);
  return out;
}

function descendants(
  foldersByParent: Map<string | null, FolderRow[]>,
  docsByFolder: Map<string | null, DocRow[]>,
  folderId: string,
): string[] {
  const out: string[] = [];
  const stack = [folderId];
  const seen = new Set([folderId]);
  while (stack.length > 0) {
    const at = stack.pop() as string;
    for (const child of foldersByParent.get(at) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      stack.push(child.id);
    }
    for (const child of docsByFolder.get(at) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
    }
  }
  return out;
}

type EditActor = { actor: Actor; at: string | null; op: string };
type EditsByDoc = Map<string, EditActor[]>;

function loadEditActors(rows: (typeof documentEdits.$inferSelect)[]): EditsByDoc {
  const byDoc: EditsByDoc = new Map();
  for (const row of rows) {
    if (!row.treeChange) continue;
    const actor = actorOf({
      threadId: row.threadId,
      turnId: row.turnId,
      userId: row.actorUserId,
    });
    const stamped =
      actor !== "unrecorded"
        ? actor
        : row.actor === "human" && row.actorUserId
          ? `user:${row.actorUserId}`
          : row.actor === "agent" && row.threadId
            ? actorOf({ threadId: row.threadId, turnId: row.turnId })
            : row.actor === "system"
              ? "unrecorded"
              : "unrecorded";
    const list = byDoc.get(row.documentId) ?? [];
    list.push({ actor: stamped, at: iso(row.createdAt), op: row.treeChange.op });
    byDoc.set(row.documentId, list);
  }
  return byDoc;
}

function firstEdit(edits: EditsByDoc, documentId: string, op: string): EditActor | undefined {
  return edits.get(documentId)?.find((row) => row.op === op);
}

export async function migrateProject(db: Database, projectId: string): Promise<MigrateResult> {
  const workRows = await db
    .select({ id: works.id })
    .from(works)
    .where(eq(works.projectId, projectId as never));
  const workIds = workRows.map((row) => row.id);
  const sourceFilter =
    workIds.length > 0
      ? or(eq(contextSources.projectId, projectId as never), inArray(contextSources.workId, workIds))
      : eq(contextSources.projectId, projectId as never);
  const sourceRows: SourceRow[] = await db.select().from(contextSources).where(sourceFilter);
  const sourceIds = sourceRows.map((row) => row.id);
  if (sourceIds.length === 0) {
    return {
      records: [],
      settled: {},
      unrecorded: [],
      actorColumns: ACTOR_COLUMNS,
      previousLocations: [],
      pendingText: {},
      counts: {
        liveCreates: 0,
        liveDeletes: 0,
        draftCreates: 0,
        draftMoves: 0,
        draftRenames: 0,
        draftDeletes: 0,
        draftRankMoves: 0,
        unrecorded: 0,
        pendingText: 0,
        inventedRecords: 0,
      },
    };
  }

  const folderRows: FolderRow[] = await db
    .select()
    .from(folders)
    .where(inArray(folders.contextSourceId, sourceIds));
  const docRows: DocRow[] = await db
    .select()
    .from(documents)
    .where(inArray(documents.contextSourceId, sourceIds));
  const openBranches = await db
    .select()
    .from(branches)
    .where(and(eq(branches.projectId, projectId as never), eq(branches.status, "active")));
  const branchIds = openBranches.map((row) => row.id);
  const changeRows: ChangeRow[] =
    branchIds.length > 0
      ? await db.select().from(branchTreeChanges).where(inArray(branchTreeChanges.branchId, branchIds))
      : [];
  const rankRows =
    branchIds.length > 0
      ? await db.select().from(branchTreeRanks).where(inArray(branchTreeRanks.branchId, branchIds))
      : [];
  const parentOrders =
    branchIds.length > 0
      ? await db
          .select()
          .from(branchTreeParentOrders)
          .where(inArray(branchTreeParentOrders.branchId, branchIds))
      : [];
  const draftRows =
    branchIds.length > 0
      ? await db
          .select({
            branchId: documentDrafts.branchId,
            documentId: documentDrafts.documentId,
            kind: documentDrafts.kind,
            status: documentDrafts.status,
            hasEffect: documentDrafts.hasEffect,
          })
          .from(documentDrafts)
          .where(inArray(documentDrafts.branchId, branchIds))
      : [];
  const editRows =
    docRows.length > 0
      ? await db
          .select()
          .from(documentEdits)
          .where(and(inArray(documentEdits.documentId, docRows.map((row) => row.id)), isNotNull(documentEdits.treeChange)))
          .orderBy(documentEdits.createdAt, documentEdits.id)
      : [];
  const previousLocations =
    docRows.length > 0
      ? await db
          .select({
            contextSourceId: documentPreviousLocations.contextSourceId,
            path: documentPreviousLocations.path,
            documentId: documentPreviousLocations.documentId,
          })
          .from(documentPreviousLocations)
          .where(inArray(documentPreviousLocations.documentId, docRows.map((row) => row.id)))
      : [];

  const edits = loadEditActors(editRows);
  const unrecorded: UnrecordedFact[] = [];
  const records: TreeOp[] = [];
  const noteUnrecorded = (fact: string, nodeId: string, reason: string) => {
    unrecorded.push({ fact, nodeId, reason });
  };

  const liveFolders = folderRows.filter((row) => !row.hidden);
  const liveDocs = docRows.filter((row) => !row.hidden);
  const foldersByParent = new Map<string | null, FolderRow[]>();
  for (const row of folderRows) {
    const key = row.parentId;
    const list = foldersByParent.get(key) ?? [];
    list.push(row);
    foldersByParent.set(key, list);
  }
  const docsByFolder = new Map<string | null, DocRow[]>();
  for (const row of docRows) {
    const key = row.folderId;
    const list = docsByFolder.get(key) ?? [];
    list.push(row);
    docsByFolder.set(key, list);
  }
  const folderById = new Map(folderRows.map((row) => [row.id, row]));
  const docById = new Map(docRows.map((row) => [row.id, row]));

  for (const row of topoFolders(liveFolders)) {
    const actor: Actor = "unrecorded";
    noteUnrecorded("create.folder", row.id, "folders have no creator column");
    records.push({
      type: "create",
      id: `mig:create:${row.id}`,
      actor,
      draft: null,
      at: iso(row.createdAt),
      node: row.id,
      kind: "folder",
      name: row.name,
      parent: parentOf(row.contextSourceId, row.parentId),
      rank: rankOf(row.rank),
    });
  }

  const liveDocsSorted = [...liveDocs].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  for (const row of liveDocsSorted) {
    const created = firstEdit(edits, row.id, "create");
    const actor = created?.actor ?? "unrecorded";
    if (actor === "unrecorded") {
      noteUnrecorded(
        "create.document",
        row.id,
        "no document_edits tree_change.op=create (and documents have no created_by)",
      );
    }
    records.push({
      type: "create",
      id: `mig:create:${row.id}`,
      actor,
      draft: null,
      at: created?.at ?? iso(row.createdAt),
      node: row.id,
      kind: nodeKindOf(row),
      name: filenameOf(row),
      parent: parentOf(row.contextSourceId, row.folderId),
      rank: rankOf(row.rank),
      ...(blobOf(row) ? { blob: blobOf(row) } : {}),
      fileType: row.fileType,
      ...(row.contentPurgedAt ? { contentPurgedAt: iso(row.contentPurgedAt) } : {}),
    });
  }

  const deletedFolders = topoFolders(liveFolders.filter((row) => row.deletedAt != null));
  for (const row of deletedFolders) {
    noteUnrecorded("delete.folder", row.id, "folders.deleted_by_work_id is not an actor");
    const cascade = descendants(foldersByParent, docsByFolder, row.id).filter((id) => {
      const folder = folderById.get(id);
      if (folder) return folder.deletedAt != null && !folder.hidden;
      const doc = docById.get(id);
      return doc != null && doc.deletedAt != null && !doc.hidden;
    });
    records.push({
      type: "delete",
      id: `mig:delete:${row.id}`,
      actor: "unrecorded",
      draft: null,
      at: iso(row.deletedAt),
      node: row.id,
      cascade,
    });
  }
  const deletedDocs = liveDocs
    .filter((row) => row.deletedAt != null)
    .sort((a, b) => a.deletedAt!.getTime() - b.deletedAt!.getTime() || (a.id < b.id ? -1 : 1));
  for (const row of deletedDocs) {
    const deletedEdit = firstEdit(edits, row.id, "delete");
    const actor =
      deletedEdit?.actor ??
      actorOf({
        threadId: row.deletedByThreadId,
        userId: row.deletedByUserId,
      });
    if (actor === "unrecorded") {
      noteUnrecorded("delete.document", row.id, "no deleted_by_thread_id/user_id and no tree_change delete");
    }
    records.push({
      type: "delete",
      id: `mig:delete:${row.id}`,
      actor,
      draft: null,
      at: deletedEdit?.at ?? iso(row.deletedAt),
      node: row.id,
      cascade: [],
    });
  }

  const changesByBranch = new Map<string, ChangeRow[]>();
  for (const row of changeRows) {
    const list = changesByBranch.get(row.branchId) ?? [];
    list.push(row);
    changesByBranch.set(row.branchId, list);
  }
  const ranksByBranch = new Map<string, (typeof rankRows)[number][]>();
  for (const row of rankRows) {
    const list = ranksByBranch.get(row.branchId) ?? [];
    list.push(row);
    ranksByBranch.set(row.branchId, list);
  }
  const ordersByBranch = new Map<string, Set<string>>();
  for (const row of parentOrders) {
    const set = ordersByBranch.get(row.branchId) ?? new Set();
    set.add(`${row.parentKind}:${row.parentId}`);
    ordersByBranch.set(row.branchId, set);
  }

  const hiddenFolders = folderRows.filter((row) => row.hidden && row.deletedAt == null && row.absorbedInto == null);
  const hiddenDocs = docRows.filter((row) => row.hidden && row.deletedAt == null);

  const branchesOldestFirst = [...openBranches].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );

  let draftCreates = 0;
  let draftMoves = 0;
  let draftRenames = 0;
  let draftDeletes = 0;
  let draftRankMoves = 0;
  const pendingText: Record<string, string[]> = {};

  for (const branch of branchesOldestFirst) {
    const draft = branch.id;
    const changes = (changesByBranch.get(branch.id) ?? []).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.nodeId < b.nodeId ? -1 : 1),
    );
    const createdDocIds = new Set(
      changes.filter((row) => row.created && row.nodeKind === "document").map((row) => row.nodeId),
    );
    const createdFolderIds = new Set(
      changes.filter((row) => row.created && row.nodeKind === "folder").map((row) => row.nodeId),
    );

    const neededHiddenFolders = new Set<string>();
    const addAncestors = (folderId: string | null) => {
      let at = folderId;
      const guard = new Set<string>();
      while (at && !guard.has(at)) {
        guard.add(at);
        const folder = folderById.get(at);
        if (!folder) break;
        if (folder.hidden && folder.deletedAt == null && folder.absorbedInto == null) {
          neededHiddenFolders.add(folder.id);
        }
        at = folder.parentId;
      }
    };
    for (const row of hiddenDocs) {
      if (createdDocIds.has(row.id)) addAncestors(row.folderId);
    }
    for (const row of changes) {
      if (row.moved && row.movedFolderId) addAncestors(row.movedFolderId);
    }
    for (const id of createdFolderIds) {
      const folder = folderById.get(id);
      if (folder) {
        neededHiddenFolders.add(folder.id);
        addAncestors(folder.parentId);
      }
    }

    for (const row of topoFolders(hiddenFolders.filter((folder) => neededHiddenFolders.has(folder.id)))) {
      noteUnrecorded("create.folder.draft", row.id, "hidden folders have no creator column");
      records.push({
        type: "create",
        id: `mig:create:${draft}:${row.id}`,
        actor: "unrecorded",
        draft,
        at: iso(row.createdAt),
        node: row.id,
        kind: "folder",
        name: row.name,
        parent: parentOf(row.contextSourceId, row.parentId),
        rank: rankOf(row.rank),
      });
      draftCreates += 1;
    }

    const createdDocs = hiddenDocs
      .filter((row) => createdDocIds.has(row.id))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    for (const row of createdDocs) {
      const change = changes.find((c) => c.nodeId === row.id && c.nodeKind === "document");
      const actor = actorOf({
        threadId: change?.createdThreadId,
        turnId: change?.createdTurnId,
      });
      if (actor === "unrecorded") {
        noteUnrecorded("create.document.draft", row.id, "created_thread_id/created_turn_id empty");
      }
      records.push({
        type: "create",
        id: `mig:create:${draft}:${row.id}`,
        actor,
        draft,
        at: iso(change?.createdAt ?? row.createdAt),
        node: row.id,
        kind: nodeKindOf(row),
        name: filenameOf(row),
        parent: parentOf(row.contextSourceId, row.folderId),
        rank: rankOf(row.rank),
        ...(blobOf(row) ? { blob: blobOf(row) } : {}),
        fileType: row.fileType,
      });
      draftCreates += 1;
    }

    for (const change of changes) {
      if (change.nodeKind !== "document") continue;
      const row = docById.get(change.nodeId);
      if (!row) continue;
      const changedBy = actorOf({
        threadId: change.changedThreadId,
        turnId: change.changedTurnId,
      });

      if (change.moved && !change.deleted) {
        const liveParent = parentOf(row.contextSourceId, row.folderId);
        const draftParent = change.movedFolderId
          ? change.movedFolderId
          : change.movedRootSourceId
            ? sourceRoot(change.movedRootSourceId)
            : liveParent;
        const liveName = filenameOf(row);
        const draftName =
          change.movedName != null ? renderFilename(change.movedName, change.movedExtension ?? "") : liveName;
        const liveRank = rankOf(row.rank);
        const draftRank = change.movedRank != null ? change.movedRank : liveRank;
        const placeChanged = draftParent !== liveParent || draftRank !== liveRank;
        const nameChanged = draftName !== liveName;
        if (placeChanged) {
          if (changedBy === "unrecorded") {
            noteUnrecorded("move.draft", row.id, "changed_thread_id/changed_turn_id empty");
          }
          records.push({
            type: "move",
            id: `mig:move:${draft}:${row.id}`,
            actor: changedBy,
            draft,
            at: iso(change.updatedAt),
            node: row.id,
            parent: draftParent,
            rank: draftRank,
            from: { parent: liveParent, rank: liveRank },
          });
          draftMoves += 1;
        }
        if (nameChanged) {
          if (changedBy === "unrecorded") {
            noteUnrecorded("rename.draft", row.id, "changed_thread_id/changed_turn_id empty");
          }
          records.push({
            type: "rename",
            id: `mig:rename:${draft}:${row.id}`,
            actor: changedBy,
            draft,
            at: iso(change.updatedAt),
            node: row.id,
            name: draftName,
            fromName: liveName,
          });
          draftRenames += 1;
        }
      }

      if (change.deleted) {
        if (changedBy === "unrecorded") {
          noteUnrecorded("delete.draft", row.id, "changed_thread_id/changed_turn_id empty");
        }
        const cascade = row.folderId ? [] : [];
        records.push({
          type: "delete",
          id: `mig:delete:${draft}:${row.id}`,
          actor: changedBy,
          draft,
          at: iso(change.updatedAt),
          node: row.id,
          cascade,
        });
        draftDeletes += 1;
      }
    }

    pendingText[draft] = [
      ...new Set(
        draftRows
          .filter(
            (row) =>
              row.branchId === branch.id &&
              row.kind === "work_draft" &&
              row.status === "active" &&
              row.hasEffect,
          )
          .map((row) => row.documentId),
      ),
    ].sort();

    const movedIds = new Set(
      records
        .filter((op) => op.draft === draft && op.type === "move")
        .map((op) => op.node),
    );
    const owned = ordersByBranch.get(branch.id) ?? new Set();
    const ranks = ranksByBranch.get(branch.id) ?? [];
    for (const rank of [...ranks].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))) {
      if (movedIds.has(rank.nodeId)) continue;
      const live =
        rank.nodeKind === "folder" ? folderById.get(rank.nodeId) : docById.get(rank.nodeId);
      if (!live) continue;
      const liveRank = rankOf(live.rank);
      if (rank.rank === liveRank && !owned.has(`${rank.parentKind}:${rank.parentId}`)) continue;
      if (rank.rank === liveRank) continue;
      const liveParent =
        rank.nodeKind === "folder"
          ? parentOf((live as FolderRow).contextSourceId, (live as FolderRow).parentId)
          : parentOf((live as DocRow).contextSourceId, (live as DocRow).folderId);
      const draftParent =
        rank.parentKind === "source" ? sourceRoot(rank.parentId) : rank.parentId;
      records.push({
        type: "move",
        id: `mig:rank:${draft}:${rank.nodeId}`,
        actor: "unrecorded",
        draft,
        at: iso(rank.updatedAt),
        node: rank.nodeId,
        parent: draftParent,
        rank: rank.rank,
        from: { parent: liveParent, rank: liveRank },
      });
      noteUnrecorded("move.rank", rank.nodeId, "branch_tree_ranks has no actor column");
      draftRankMoves += 1;
      movedIds.add(rank.nodeId);
    }
  }

  const liveCreates = records.filter((op) => op.draft === null && op.type === "create").length;
  const liveDeletes = records.filter((op) => op.draft === null && op.type === "delete").length;

  const pendingTextCount = Object.values(pendingText).reduce((n, ids) => n + ids.length, 0);
  return {
    records,
    settled: {},
    unrecorded,
    actorColumns: ACTOR_COLUMNS,
    previousLocations,
    pendingText,
    counts: {
      liveCreates,
      liveDeletes,
      draftCreates,
      draftMoves,
      draftRenames,
      draftDeletes,
      draftRankMoves,
      unrecorded: unrecorded.length,
      pendingText: pendingTextCount,
      inventedRecords: records.filter((op) => op.type === "restore" && op.draft !== null).length,
    },
  };
}

export function stableRecords(records: TreeOp[]): string {
  return JSON.stringify(records);
}
