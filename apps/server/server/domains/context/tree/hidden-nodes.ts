/**
 * Hidden-node lifecycle (contract §6, §7, §12): a draft's create makes or joins a hidden
 * live row; a live create at a hidden node's path reveals it instead of inserting a twin;
 * one placement step (reveal or restore) brings a node into the live tree with its
 * ancestors; and end of use tombstones a hidden node no draft uses any more.
 *
 * Every function runs in its caller's transaction, which already holds the locks §14
 * names before the document locks taken here: Work rows, the draft row, then namespace
 * advisory locks. Hidden nodes are tombstoned, never hard-deleted, and a draft's create
 * never seeds live Yjs (its text lives in the draft's branch).
 */
import type { ContextSourceId, DocumentId, DraftId, FolderId } from "@meridian/contracts";
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  documentBranches,
  documentMarkdownProjections,
  documents,
  folders,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import { claimDocumentLocation } from "../adapters/context-fs/document-locations.js";
import { renderFilename } from "../context/paths.js";
import type { DocumentCreationMetadata } from "../document-metadata.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import { dropDocumentRows, recordCreated } from "./draft-tree-store.js";
import { spellNodeAddresses } from "./tree-addresses.js";
import {
  createTreeReader,
  LIVE_TREE,
  type NodeRef,
  type TreeReader,
  type TreeView,
} from "./tree-view.js";
import {
  type DocumentSlot,
  findHiddenFolder,
  isUnusedHiddenFolder,
  loadActiveDraftUses,
  loadDocumentIdentityRows,
  loadFolderIdentityRows,
  loadHiddenDocumentCandidates,
} from "./tree-view-sql.js";

export type CreateFault =
  /** Opposite kind at the path, or a binary create where a document sits. */
  | { code: "conflict" }
  /** The path names two or more nodes in the view. */
  | { code: "ambiguous"; ids: readonly string[] };

/**
 * Test-only injection points on this module's production code (contract §16.1), wired
 * like the mover's `setBeforeDestructiveWrite`. Production never sets them.
 */
export type HiddenNodeHookPoint =
  | "createInDraft.afterCandidateLock"
  | "createLive.afterCandidateLock"
  | "createLive.afterHeldAdmission"
  | "endUse.afterRevalidate"
  | "place.afterRevalidate";
const hooks = new Map<HiddenNodeHookPoint, () => Promise<void>>();

/** Installs a hook; the returned function removes it. */
export function setHiddenNodeHook(
  point: HiddenNodeHookPoint,
  hook: () => Promise<void>,
): () => void {
  hooks.set(point, hook);
  return () => {
    if (hooks.get(point) === hook) hooks.delete(point);
  };
}

/** Runs the hook installed at `point`, if any (a no-op in production). */
export async function hiddenNodeHook(point: HiddenNodeHookPoint): Promise<void> {
  await hooks.get(point)?.();
}
const hook = hiddenNodeHook;

function filePath(dir: readonly string[], name: string, extension: string): string {
  return [...dir, renderFilename(name, extension)].join("/");
}

async function lockDocuments(db: Database, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockDocumentMutation(currentDrizzleDb(db), id);
}

// ---------------------------------------------------------------------------------------
// Draft creates (§6.2)
// ---------------------------------------------------------------------------------------

export type TrackedNode = {
  kind: "tracked";
  filetype: Filetype;
  metadata?: DocumentCreationMetadata;
};
export type BinaryNode = {
  kind: "binary";
  documentId?: DocumentId;
  fileType: DocumentFileType;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  metadata?: JsonObject | DocumentCreationMetadata;
};

export type DraftCreateResult =
  /** Something already sits at the path in the draft's view. */
  | { kind: "existing"; documentId: DocumentId; binary: boolean }
  /** The draft now uses this document: a new hidden row, or (`joined`) another draft's. */
  | { kind: "created"; documentId: DocumentId; joined: boolean };

/**
 * A draft's create at `dir/name.extension` (§6.2): hidden folders as needed, then the
 * document, joined when another draft's hidden text document sits at the path, recorded
 * as the draft's `created` row at the draft's location, with the draft's branch and its
 * settlements of unsettled ahead refs at that address. Runs in the command transaction
 * that holds the drafting Work, the draft and the source's namespace.
 */
export async function createInDraft(
  db: Database,
  input: {
    draftId: DraftId;
    contextSourceId: ContextSourceId;
    dir: readonly string[];
    name: string;
    extension: string;
    node: TrackedNode | BinaryNode;
    /** Empty live Yjs for a new text row (never seeded). */
    ensureEmptyContent(documentId: DocumentId): Promise<void>;
    /** The draft's branch on a text document, seeded from its empty live document. */
    ensureDraftBranch(documentId: DocumentId): Promise<void>;
  },
): Promise<Result<DraftCreateResult, CreateFault>> {
  const tree = createTreeReader(db);
  const view: TreeView = { kind: "draft", draftId: input.draftId };
  const at = filePath(input.dir, input.name, input.extension);
  const occupant = await tree.resolvePath(view, {
    contextSourceId: input.contextSourceId,
    path: at,
  });
  if (occupant.kind === "ambiguous") return Err({ code: "ambiguous", ids: occupant.ids });
  if (occupant.kind === "found") {
    if (occupant.node.kind === "folder") return Err({ code: "conflict" });
    const binary = occupant.node.document.storageUrl !== null;
    if (input.node.kind === "binary") return Err({ code: "conflict" });
    return Ok({ kind: "existing", documentId: occupant.node.document.id, binary });
  }

  const folder = await draftFolderPath(db, tree, view, input.contextSourceId, input.dir);
  if (!folder.ok) return folder;
  const slot: DocumentSlot = {
    contextSourceId: input.contextSourceId,
    folderId: folder.value,
    name: input.name,
    extension: input.extension,
  };

  let documentId: DocumentId | null = null;
  let joined = false;
  if (input.node.kind === "tracked") {
    documentId = await joinHiddenDocument(db, slot, input.draftId);
    joined = documentId !== null;
  }
  if (documentId === null) {
    documentId = await insertHiddenDocument(db, slot, input.node);
    if (input.node.kind === "tracked") await input.ensureEmptyContent(documentId);
  }

  await recordCreated(db, {
    draftId: input.draftId,
    documentId,
    location: {
      contextSourceId: slot.contextSourceId,
      parentFolderId: slot.folderId,
      name: slot.name,
      extension: slot.extension,
    },
  });
  if (input.node.kind === "tracked") await input.ensureDraftBranch(documentId);
  await settleAheadRefsInDraft(db, input.draftId, documentId, slot);
  return Ok({ kind: "created", documentId, joined });
}

/**
 * Folders root to leaf for a draft create: a folder the draft sees, else a hidden live
 * folder at the location (joined: a folder's use is implied by what is placed under it),
 * else a new hidden folder. Below the first folder the draft doesn't see, nothing of the
 * draft's sits (a hidden folder holds only hidden nodes, and the draft would see a folder
 * it placed something under), so the walk continues by hidden location.
 */
async function draftFolderPath(
  db: Database,
  tree: TreeReader,
  view: TreeView,
  contextSourceId: ContextSourceId,
  dir: readonly string[],
): Promise<Result<FolderId | null, CreateFault>> {
  let parentId: FolderId | null = null;
  let seen = true;
  for (const [index, name] of dir.entries()) {
    if (seen) {
      const found = await tree.resolvePath(view, {
        contextSourceId,
        path: dir.slice(0, index + 1).join("/"),
      });
      if (found.kind === "ambiguous") return Err({ code: "ambiguous", ids: found.ids });
      if (found.kind === "found") {
        if (found.node.kind === "document") return Err({ code: "conflict" });
        parentId = found.node.folder.id;
        continue;
      }
      seen = false;
    }
    const hidden = await findHiddenFolder(db, { contextSourceId, parentId, name });
    parentId = hidden ?? (await insertFolder(db, { contextSourceId, parentId, name }, true));
  }
  return Ok(parentId);
}

/**
 * The oldest valid hidden text document at the slot that the draft doesn't use yet.
 * Every candidate's document lock is taken in one id-ordered pass before any is chosen,
 * then each is revalidated under its lock; a candidate no active draft uses is an
 * inconsistent row and is tombstoned here (repair on touch, §12.4).
 */
async function joinHiddenDocument(
  db: Database,
  slot: DocumentSlot,
  draftId: DraftId,
): Promise<DocumentId | null> {
  const candidates = await loadHiddenDocumentCandidates(db, slot, { excludeDraftId: draftId });
  const ids = candidates.map((candidate) => candidate.id);
  await lockDocuments(db, ids);
  await hook("createInDraft.afterCandidateLock");
  if (candidates.length === 0) return null;
  const valid = await loadHiddenDocumentCandidates(db, slot, { excludeDraftId: draftId, ids });
  await tombstoneDocuments(
    db,
    valid.filter((candidate) => candidate.activeUses === 0).map((candidate) => candidate.id),
  );
  return valid.find((candidate) => candidate.activeUses > 0)?.id ?? null;
}

async function insertHiddenDocument(
  db: Database,
  slot: DocumentSlot,
  node: TrackedNode | BinaryNode,
): Promise<DocumentId> {
  const tx = currentDrizzleDb(db);
  const [row] = await tx
    .insert(documents)
    .values({
      ...(node.kind === "binary" && node.documentId ? { id: node.documentId } : {}),
      contextSourceId: slot.contextSourceId,
      folderId: slot.folderId,
      name: slot.name,
      extension: slot.extension,
      hidden: true,
      ...(node.kind === "tracked"
        ? { fileType: node.filetype, sizeBytes: 0 }
        : {
            fileType: node.fileType,
            storageUrl: node.storageUrl,
            mimeType: node.mimeType,
            sizeBytes: node.sizeBytes,
          }),
      ...(node.metadata ? { metadata: node.metadata as JsonObject } : {}),
    })
    .returning({ id: documents.id });
  if (!row) throw new Error(`Hidden document ${slot.name} was not inserted`);
  if (node.kind === "tracked") {
    await tx.insert(documentMarkdownProjections).values({ documentId: row.id, markdown: "" });
  }
  return row.id;
}

/** Each unsettled ahead ref at the draft's address now means this document in the draft (12a rule 1). */
async function settleAheadRefsInDraft(
  db: Database,
  draftId: DraftId,
  documentId: DocumentId,
  slot: DocumentSlot,
): Promise<void> {
  const [address] = await spellNodeAddresses(currentDrizzleDb(db), [
    {
      documentId,
      contextSourceId: slot.contextSourceId,
      folderId: slot.folderId,
      name: slot.name,
      extension: slot.extension,
      fileType: "",
    },
  ]);
  if (!address) return;
  await currentDrizzleDb(db).execute(sql`
    INSERT INTO link_ahead_draft_settlements (ahead_id, draft_id, document_id)
    SELECT r.ahead_id, ${draftId}::uuid, ${documentId}::uuid FROM link_ahead_refs r
    WHERE r.project_id = ${address.projectId}::uuid AND r.scheme = ${address.scheme}
      AND r.work_id IS NOT DISTINCT FROM ${address.workId}::uuid
      AND md5(r.path) = md5(${address.path}) AND r.path = ${address.path}
      AND r.settled_document_id IS NULL
    ON CONFLICT DO NOTHING`);
}

// ---------------------------------------------------------------------------------------
// Live creates (§6.3, §6.4)
// ---------------------------------------------------------------------------------------

export type LiveCreateCandidate =
  | { occupant: DocumentId }
  /** A hidden text document a live create there would reveal, and its current source. */
  | { candidate: DocumentId; sourceId: ContextSourceId }
  | { none: true };

/**
 * What a live create at this path would find, holding nothing (§6.3 step 1): a visible
 * occupant, the hidden candidate it would reveal, or nothing. The caller takes the
 * candidate's live lease before its transaction when the create carries content.
 */
export async function findLiveCreateCandidate(
  db: Database,
  at: { contextSourceId: ContextSourceId; dir: readonly string[]; name: string; extension: string },
): Promise<LiveCreateCandidate> {
  const tree = createTreeReader(db);
  const path = filePath(at.dir, at.name, at.extension);
  const occupant = await tree.resolvePath(LIVE_TREE, { contextSourceId: at.contextSourceId, path });
  if (occupant.kind === "found" && occupant.node.kind === "document") {
    return { occupant: occupant.node.document.id };
  }
  if (occupant.kind !== "not_found") return { none: true };
  const folderId = await liveFolderAt(db, tree, at.contextSourceId, at.dir);
  if (folderId === undefined) return { none: true };
  const [candidate] = (
    await loadHiddenDocumentCandidates(db, {
      contextSourceId: at.contextSourceId,
      folderId,
      name: at.name,
      extension: at.extension,
    })
  ).filter((each) => each.activeUses > 0);
  if (!candidate) return { none: true };
  const [row] = await loadDocumentIdentityRows(currentDrizzleDb(db), [candidate.id]);
  return row ? { candidate: candidate.id, sourceId: row.contextSourceId } : { none: true };
}

/**
 * The folder a live create at `dir` lands in, without making anything: a visible folder,
 * else a hidden folder ensureLiveFolderPath would reveal; undefined past the first gap.
 */
async function liveFolderAt(
  db: Database,
  tree: TreeReader,
  contextSourceId: ContextSourceId,
  dir: readonly string[],
): Promise<FolderId | null | undefined> {
  let parentId: FolderId | null = null;
  for (const [index, name] of dir.entries()) {
    const found = await tree.resolvePath(LIVE_TREE, {
      contextSourceId,
      path: dir.slice(0, index + 1).join("/"),
    });
    if (found.kind === "found" && found.node.kind === "folder") {
      parentId = found.node.folder.id;
      continue;
    }
    if (found.kind !== "not_found") return undefined;
    const hidden = await findHiddenFolder(db, { contextSourceId, parentId, name });
    if (!hidden) return undefined;
    parentId = hidden;
  }
  return parentId;
}

/**
 * Live folders root to leaf (§6.3 step 1; `mkdir` and the mover's folder ensure): a
 * visible folder is used; a hidden live folder at the path is revealed in place (its
 * ancestors are visible: the walk comes from the root); otherwise, after the live
 * opposite-kind check, a visible folder is inserted and its location claimed. The caller
 * holds the source's namespace lock.
 */
export async function ensureLiveFolderPath(
  db: Database,
  input: {
    contextSourceId: ContextSourceId;
    dir: readonly string[];
    catalog?: ContextCatalogMutationPort;
  },
): Promise<Result<{ folderId: FolderId | null; created: readonly FolderId[] }, CreateFault>> {
  const tree = createTreeReader(db);
  const { contextSourceId } = input;
  let parentId: FolderId | null = null;
  const created: FolderId[] = [];
  for (const [index, name] of input.dir.entries()) {
    const found = await tree.resolvePath(LIVE_TREE, {
      contextSourceId,
      path: input.dir.slice(0, index + 1).join("/"),
    });
    if (found.kind === "found" && found.node.kind === "folder") {
      parentId = found.node.folder.id;
      continue;
    }
    if (found.kind !== "not_found") return Err({ code: "conflict" });
    const hidden = await findHiddenFolder(db, { contextSourceId, parentId, name });
    const folderId: FolderId =
      hidden ?? (await insertFolder(db, { contextSourceId, parentId, name }, false));
    if (hidden) await updatePlacedFolder(db, hidden, { parentId, clear: "hidden" });
    await claimDocumentLocation(db, contextSourceId, parentId, name);
    parentId = folderId;
    created.push(folderId);
  }
  if (created.length > 0) await input.catalog?.refreshSources([contextSourceId], created);
  return Ok({ folderId: parentId, created });
}

async function parentOf(db: Database, folderId: FolderId): Promise<FolderId | null> {
  const [row] = await loadFolderIdentityRows(currentDrizzleDb(db), [folderId]);
  return row?.parentId ?? null;
}

export type LiveCreateOutcome =
  | { kind: "revealed"; documentId: DocumentId; sourceIds: readonly ContextSourceId[] }
  | { kind: "inserted"; documentId: DocumentId };

export type LiveCreateFault =
  | CreateFault
  /** The candidate seen before the transaction isn't the one found under its lock. */
  | { code: "candidate_changed" };

/**
 * A live create at `slot` (§6.3 step 2, §6.4): reveals the oldest valid hidden text
 * document at the path, or the named document (`revealById`), instead of inserting a
 * twin; otherwise `insert` makes the visible row. `expected` is the candidate the caller
 * discovered before its transaction (and holds the live lease of, for a create with
 * content): a different candidate, none, or a moved one is `candidate_changed`. The
 * caller holds the namespaces of the destination and of the candidate's current source,
 * and has checked that no visible node sits at the path.
 */
export async function createLive(
  db: Database,
  input: {
    slot: DocumentSlot;
    binary: boolean;
    revealById?: DocumentId;
    expected?: { documentId: DocumentId; sourceId: ContextSourceId } | { none: true };
    catalog?: ContextCatalogMutationPort;
    insert(): Promise<DocumentId>;
  },
): Promise<Result<LiveCreateOutcome, LiveCreateFault>> {
  const chosen = input.revealById
    ? await revalidateRevealById(db, input.revealById, input.expected)
    : input.binary
      ? null
      : await chooseLiveCandidate(db, input.slot);
  if (chosen === "changed") return Err({ code: "candidate_changed" });
  if (input.expected && !input.revealById) {
    const expectedId = "documentId" in input.expected ? input.expected.documentId : null;
    if ((chosen?.id ?? null) !== expectedId) return Err({ code: "candidate_changed" });
    if (chosen && "sourceId" in input.expected && chosen.sourceId !== input.expected.sourceId) {
      return Err({ code: "candidate_changed" });
    }
  }
  if (!chosen) return Ok({ kind: "inserted", documentId: await input.insert() });
  const placed = await place(db, {
    targets: [
      {
        node: { kind: "document", id: chosen.id },
        at: {
          contextSourceId: input.slot.contextSourceId,
          parentFolderId: input.slot.folderId,
          name: input.slot.name,
          extension: input.slot.extension,
        },
        mode: "reveal",
      },
    ],
    catalog: input.catalog,
  });
  if (!placed.ok) {
    return Err(
      placed.error.code === "stale" ? { code: "candidate_changed" } : { code: "conflict" },
    );
  }
  return Ok({ kind: "revealed", documentId: chosen.id, sourceIds: placed.value.sourceIds });
}

async function chooseLiveCandidate(
  db: Database,
  slot: DocumentSlot,
): Promise<{ id: DocumentId; sourceId: ContextSourceId } | null> {
  const candidates = await loadHiddenDocumentCandidates(db, slot);
  const ids = candidates.map((candidate) => candidate.id);
  await lockDocuments(db, ids);
  await hook("createLive.afterCandidateLock");
  if (candidates.length === 0) return null;
  const valid = await loadHiddenDocumentCandidates(db, slot, { ids });
  await tombstoneDocuments(
    db,
    valid.filter((candidate) => candidate.activeUses === 0).map((candidate) => candidate.id),
  );
  const chosen = valid.find((candidate) => candidate.activeUses > 0);
  if (!chosen) return null;
  const [row] = await loadDocumentIdentityRows(currentDrizzleDb(db), [chosen.id]);
  return row ? { id: chosen.id, sourceId: row.contextSourceId } : null;
}

/** §6.4: the named document, under its lock, is still hidden, live, used and in its source. */
async function revalidateRevealById(
  db: Database,
  documentId: DocumentId,
  expected: { documentId: DocumentId; sourceId: ContextSourceId } | { none: true } | undefined,
): Promise<{ id: DocumentId; sourceId: ContextSourceId } | "changed"> {
  await lockDocuments(db, [documentId]);
  const [row] = await loadDocumentIdentityRows(currentDrizzleDb(db), [documentId]);
  const uses = await loadActiveDraftUses(currentDrizzleDb(db), [documentId]);
  if (!row?.hidden || row.deleted || uses.length === 0) return "changed";
  if (expected && "sourceId" in expected && expected.sourceId !== row.contextSourceId) {
    return "changed";
  }
  return { id: documentId, sourceId: row.contextSourceId };
}

// ---------------------------------------------------------------------------------------
// Placement (§7)
// ---------------------------------------------------------------------------------------

export type LiveLocation = {
  contextSourceId: ContextSourceId;
  parentFolderId: FolderId | null;
  name: string;
  /** Documents only. */
  extension?: string;
};

export type PlaceTarget = {
  node: NodeRef;
  at: LiveLocation;
  /** reveal: the node must be hidden and live; restore: soft-deleted and visible (not a tombstone). */
  mode: "reveal" | "restore";
};

export type PlaceResult = {
  /** Targets plus revealed or restored ancestors. */
  placed: readonly NodeRef[];
  /** Hidden ancestors a visible folder already held the path of; the target went under it. */
  absorbed: readonly FolderId[];
  restored: readonly NodeRef[];
  /** For the catalog refresh. */
  sourceIds: readonly ContextSourceId[];
};

export type PlaceFault =
  | { code: "path_taken"; at: string; occupant: NodeRef }
  | { code: "stale"; node: NodeRef };

/**
 * One placement step (§7): each target, hidden (reveal) or soft-deleted (restore), into
 * the live tree at its final location, with its ancestors. Settles no links: its callers
 * do once the tree is final. The caller holds the namespaces of every source involved and
 * the document locks of every target document.
 */
export async function place(
  db: Database,
  input: { targets: readonly PlaceTarget[]; catalog?: ContextCatalogMutationPort },
): Promise<Result<PlaceResult, PlaceFault>> {
  const tree = createTreeReader(db);
  const placed: NodeRef[] = [];
  const restored: NodeRef[] = [];
  const absorbed: FolderId[] = [];
  const sourceIds = new Set<ContextSourceId>();
  for (const target of input.targets) {
    const stale = await revalidatePlacement(db, target);
    if (stale) return Err(stale);
    await hook("place.afterRevalidate");
    const ancestors = await placeAncestors(db, tree, target);
    if (!ancestors.ok) return ancestors;
    placed.push(...ancestors.value.placed);
    restored.push(...ancestors.value.restored);
    absorbed.push(...ancestors.value.absorbed);
    const parentId = ancestors.value.parentId;
    const filename =
      target.node.kind === "document"
        ? renderFilename(target.at.name, target.at.extension ?? "")
        : target.at.name;
    const path = [...ancestors.value.path, filename].join("/");
    const occupant = await tree.resolvePath(LIVE_TREE, {
      contextSourceId: target.at.contextSourceId,
      path,
    });
    if (occupant.kind === "found") {
      const node: NodeRef =
        occupant.node.kind === "document"
          ? { kind: "document", id: occupant.node.document.id }
          : { kind: "folder", id: occupant.node.folder.id };
      if (node.id !== target.node.id) return Err({ code: "path_taken", at: path, occupant: node });
    } else if (occupant.kind === "ambiguous") {
      const other = occupant.ids.find((id) => id !== target.node.id) as string;
      return Err({
        code: "path_taken",
        at: path,
        occupant: { kind: "document", id: other as DocumentId },
      });
    }
    const clear = target.mode === "reveal" ? "hidden" : "deleted";
    if (target.node.kind === "document") {
      await currentDrizzleDb(db)
        .update(documents)
        .set({
          contextSourceId: target.at.contextSourceId,
          folderId: parentId,
          name: target.at.name,
          extension: target.at.extension ?? "",
          ...(clear === "hidden" ? { hidden: false } : { deletedAt: null }),
          locationVersion: sql`${documents.locationVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, target.node.id));
    } else {
      await updatePlacedFolder(db, target.node.id, {
        parentId,
        clear,
        contextSourceId: target.at.contextSourceId,
        name: target.at.name,
      });
    }
    await claimDocumentLocation(db, target.at.contextSourceId, parentId, filename);
    placed.push(target.node);
    if (target.mode === "restore") restored.push(target.node);
    sourceIds.add(target.at.contextSourceId);
  }
  const ids = placed.map((node) => node.id);
  if (input.catalog && sourceIds.size > 0) await input.catalog.refreshSources([...sourceIds], ids);
  return Ok({ placed, absorbed, restored, sourceIds: [...sourceIds] });
}

async function revalidatePlacement(
  db: Database,
  target: PlaceTarget,
): Promise<{ code: "stale"; node: NodeRef } | null> {
  const want = (hidden: boolean, deleted: boolean) =>
    target.mode === "reveal" ? hidden && !deleted : !hidden && deleted;
  if (target.node.kind === "document") {
    const [row] = await loadDocumentIdentityRows(currentDrizzleDb(db), [target.node.id]);
    return row && want(row.hidden, row.deleted) ? null : { code: "stale", node: target.node };
  }
  const [row] = await loadFolderIdentityRows(currentDrizzleDb(db), [target.node.id]);
  return row && want(row.hidden, row.deleted) ? null : { code: "stale", node: target.node };
}

/**
 * The final location's folder chain, root down (TM invariant 2, decision 9): a visible
 * folder is kept; a hidden one is revealed, or, when a visible folder already holds its
 * path, the walk continues under that one; a soft-deleted one (restore) is restored, or
 * the walk continues under the folder that now holds its path, unless a document does.
 * Each placed folder takes the walk's current parent, so a repointed chain stays whole.
 */
async function placeAncestors(
  db: Database,
  tree: TreeReader,
  target: PlaceTarget,
): Promise<
  Result<
    {
      parentId: FolderId | null;
      path: string[];
      placed: NodeRef[];
      restored: NodeRef[];
      absorbed: FolderId[];
    },
    PlaceFault
  >
> {
  const chainIds: FolderId[] = [];
  let next = target.at.parentFolderId;
  const seen = new Set<FolderId>();
  while (next !== null && !seen.has(next)) {
    seen.add(next);
    chainIds.unshift(next);
    next = await parentOf(db, next);
  }
  const rows = new Map(
    (await loadFolderIdentityRows(currentDrizzleDb(db), chainIds)).map((row) => [row.id, row]),
  );
  const { contextSourceId } = target.at;
  let parentId: FolderId | null = null;
  const path: string[] = [];
  const placed: NodeRef[] = [];
  const restored: NodeRef[] = [];
  const absorbed: FolderId[] = [];
  for (const id of chainIds) {
    const row = rows.get(id);
    if (!row) return Err({ code: "stale", node: { kind: "folder", id } });
    path.push(row.name);
    if (!row.hidden && !row.deleted && row.parentId === parentId) {
      parentId = row.id;
      continue;
    }
    const holder = await tree.resolvePath(LIVE_TREE, { contextSourceId, path: path.join("/") });
    if (holder.kind === "found" && holder.node.kind === "folder") {
      if (row.hidden) absorbed.push(row.id);
      parentId = holder.node.folder.id;
      continue;
    }
    if (holder.kind === "found" && holder.node.kind === "document") {
      return Err({
        code: "path_taken",
        at: path.join("/"),
        occupant: { kind: "document", id: holder.node.document.id },
      });
    }
    if (holder.kind === "ambiguous") {
      return Err({
        code: "path_taken",
        at: path.join("/"),
        occupant: { kind: "document", id: holder.ids[0] as DocumentId },
      });
    }
    if (row.hidden && row.deleted) return Err({ code: "stale", node: { kind: "folder", id } });
    await updatePlacedFolder(db, row.id, {
      parentId,
      clear: row.hidden ? "hidden" : row.deleted ? "deleted" : null,
      contextSourceId,
    });
    await claimDocumentLocation(db, contextSourceId, parentId, row.name);
    placed.push({ kind: "folder", id: row.id });
    if (row.deleted) restored.push({ kind: "folder", id: row.id });
    parentId = row.id;
  }
  return Ok({ parentId, path, placed, restored, absorbed });
}

async function insertFolder(
  db: Database,
  at: { contextSourceId: ContextSourceId; parentId: FolderId | null; name: string },
  hidden: boolean,
): Promise<FolderId> {
  const [row] = await currentDrizzleDb(db)
    .insert(folders)
    .values({ contextSourceId: at.contextSourceId, parentId: at.parentId, name: at.name, hidden })
    .returning({ id: folders.id });
  if (!row) throw new Error(`Folder ${at.name} was not inserted`);
  return row.id;
}

async function updatePlacedFolder(
  db: Database,
  folderId: FolderId,
  change: {
    parentId: FolderId | null;
    clear: "hidden" | "deleted" | null;
    contextSourceId?: ContextSourceId;
    name?: string;
  },
): Promise<void> {
  await currentDrizzleDb(db)
    .update(folders)
    .set({
      parentId: change.parentId,
      ...(change.contextSourceId ? { contextSourceId: change.contextSourceId } : {}),
      ...(change.name ? { name: change.name } : {}),
      ...(change.clear === "hidden" ? { hidden: false } : {}),
      ...(change.clear === "deleted" ? { deletedAt: null } : {}),
      locationVersion: sql`${folders.locationVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(folders.id, folderId));
}

// ---------------------------------------------------------------------------------------
// End of use (§12.2 steps 3–5, §12.5)
// ---------------------------------------------------------------------------------------

/**
 * The draft stops using these documents: its rows and its settlements naming them go,
 * then each hidden document no active draft uses any more is tombstoned under its lock,
 * and its hidden folders bottom-up while nothing live sits under them and no draft
 * places anything there. A revealed document is live and stays. The caller holds the
 * Work, the draft and the namespaces; storage release is lane D's.
 */
export async function endUse(
  db: Database,
  input: { draftId: DraftId; documentIds: readonly DocumentId[] },
): Promise<{ tombstoned: readonly NodeRef[]; releasedObjects: readonly string[] }> {
  const ids = [...new Set(input.documentIds)].sort();
  if (ids.length === 0) return { tombstoned: [], releasedObjects: [] };
  await dropDocumentRows(db, { draftId: input.draftId, documentIds: ids });
  await lockDocuments(db, ids);
  const tx = currentDrizzleDb(db);
  const rows = await loadDocumentIdentityRows(tx, ids);
  const used = new Set((await loadActiveDraftUses(tx, ids)).map((use) => use.documentId));
  const ending = rows.filter((row) => row.hidden && !row.deleted && !used.has(row.id));
  await hook("endUse.afterRevalidate");
  const tombstoned: NodeRef[] = [];
  if (ending.length === 0) return { tombstoned, releasedObjects: [] };
  await tombstoneDocuments(
    db,
    ending.map((row) => row.id),
  );
  tombstoned.push(...ending.map((row) => ({ kind: "document" as const, id: row.id })));
  const visited = new Set<FolderId>();
  for (const row of ending) {
    let folderId = row.folderId;
    while (folderId !== null && !visited.has(folderId)) {
      visited.add(folderId);
      if (!(await isUnusedHiddenFolder(tx, folderId))) break;
      const parent = await parentOf(db, folderId);
      await currentDrizzleDb(db)
        .update(folders)
        .set({ deletedAt: new Date(), locationVersion: sql`${folders.locationVersion} + 1` })
        .where(eq(folders.id, folderId));
      tombstoned.push({ kind: "folder", id: folderId });
      folderId = parent;
    }
  }
  return {
    tombstoned,
    releasedObjects: ending.flatMap((row) => (row.storageUrl ? [row.storageUrl] : [])),
  };
}

async function tombstoneDocuments(db: Database, ids: readonly DocumentId[]): Promise<void> {
  if (ids.length === 0) return;
  await currentDrizzleDb(db)
    .update(documents)
    .set({ deletedAt: new Date(), locationVersion: sql`${documents.locationVersion} + 1` })
    .where(inArray(documents.id, [...ids]));
}

/**
 * Reverse a draft's create for a rolled-back reply or a failed create (§12.5, O-11):
 * only while the draft's text branch on the document holds no committed rows (another
 * thread's or reply's contribution would make the create stand). Then the draft's use
 * ends and its empty branches on the document go with it. The caller holds the Work,
 * the draft, the namespace and runs in the command transaction.
 */
export async function retractCreate(
  db: Database,
  input: {
    draftId: DraftId;
    /** The Work whose branches carry the draft's text until branches are keyed by draft. */
    workId: string;
    documentId: DocumentId;
  },
): Promise<{ retracted: boolean; tombstoned: readonly NodeRef[] }> {
  const tx = currentDrizzleDb(db);
  await lockDocuments(db, [input.documentId]);
  const [created] = (await loadActiveDraftUses(tx, [input.documentId])).filter(
    (use) => use.draftId === input.draftId,
  );
  if (!created) return { retracted: false, tombstoned: [] };
  const draftBranches = await tx
    .select({ id: documentBranches.id, generation: documentBranches.generation })
    .from(documentBranches)
    .where(
      and(
        eq(documentBranches.documentId, input.documentId),
        eq(documentBranches.kind, "work_draft"),
        eq(documentBranches.status, "active"),
        eq(documentBranches.workId, input.workId as never),
      ),
    );
  const draftBranchIds = draftBranches.map((branch) => branch.id);
  const peers =
    draftBranchIds.length === 0
      ? []
      : await tx
          .select({ id: documentBranches.id, generation: documentBranches.generation })
          .from(documentBranches)
          .where(inArray(documentBranches.upstreamBranchId, draftBranchIds));
  const branches = [...peers, ...draftBranches];
  for (const branch of branches) {
    const [committed] = await tx
      .select({ id: branchWriteJournal.id })
      .from(branchWriteJournal)
      .where(
        and(
          eq(branchWriteJournal.branchId, branch.id),
          eq(branchWriteJournal.generation, branch.generation),
          inArray(branchWriteJournal.status, ["active", "pushed"]),
        ),
      )
      .limit(1);
    if (committed) return { retracted: false, tombstoned: [] };
  }
  if (branches.length > 0) {
    await tx.delete(documentBranches).where(
      inArray(
        documentBranches.id,
        branches.map((branch) => branch.id),
      ),
    );
  }
  const ended = await endUse(db, { draftId: input.draftId, documentIds: [input.documentId] });
  return { retracted: true, tombstoned: ended.tombstoned };
}
