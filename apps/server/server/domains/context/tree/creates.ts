/**
 * Creates at a path (contract §6.2–§6.4): a branch's create makes or joins a hidden live
 * row; a live create at a hidden node's path reveals it instead of inserting a twin. Both
 * pick a hidden candidate the same way, and repair on touch: a hidden document no active
 * branch uses, met under its lock, is tombstoned (§12.4).
 *
 * Every function runs in its caller's transaction, which already holds the locks §14
 * names before the document locks taken here: Work rows, the branch row, then namespace
 * advisory locks. A branch's create never seeds live content: a new text row gets an empty
 * live Yjs document, and its text lives in the document's draft.
 */
import type { BranchId, ContextSourceId, DocumentId, ThreadId, TurnId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { Err, Ok, type Result } from "../../../shared/result.js";
import { isStorageBackedDocument } from "../adapters/catalog-file-mapper.js";
import { recordCreated } from "./branch-tree-store.js";
import type { HiddenNodeRepair } from "./hidden-node-repair.js";
import type {
  BinaryNode,
  BranchCreateResult,
  CreateFault,
  LiveClaim,
  LiveCreateCandidate,
  TrackedNode,
} from "./hidden-node-types.js";
import { filePath, insertDocumentRow, insertFolder, lockDocuments } from "./node-rows.js";
import { type PlaceResult, place, walkFolders } from "./placement.js";
import { type TreeHookPoint, treeHook } from "./test-hooks.js";
import { createTreeReader, LIVE_TREE, type TreeView } from "./tree-view.js";
import {
  type DocumentSlot,
  findHiddenFolder,
  loadHiddenDocumentCandidates,
} from "./tree-view-sql.js";

// ---------------------------------------------------------------------------------------
// Branch creates (§6.2)
// ---------------------------------------------------------------------------------------

/**
 * A branch's create at `dir/name.extension` (§6.2): hidden folders as needed, then the
 * document, joined when another branch's hidden text document sits at the path, recorded
 * as the branch's `created` row at the branch's location, with the document's draft and its
 * settlements of unsettled ahead refs at that address. Runs in the command transaction
 * that holds the drafting Work, the branch and the source's namespace.
 */
export async function createInBranch(
  db: Database,
  input: {
    branchId: BranchId;
    contextSourceId: ContextSourceId;
    dir: readonly string[];
    name: string;
    extension: string;
    node: TrackedNode | BinaryNode;
    /** The chat that made the create, recorded for the review row (§3.3). */
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
    /** A new text row's authority, empty, in this transaction (never seeded). */
    initializeEmptyContent(documentId: DocumentId): Promise<void>;
    /** A joined text row whose authority is missing, repaired from its stored projection. */
    repairContent(documentId: DocumentId): Promise<void>;
    /** The branch's draft of a text document, seeded from its empty live document. */
    ensureDocumentDraft(documentId: DocumentId): Promise<void>;
    /** Where a repair on touch is reported, to be warned about once this commits (§12.4). */
    repair?: Pick<HiddenNodeRepair, "report" | "tombstoneUnused">;
  },
): Promise<Result<BranchCreateResult, CreateFault>> {
  const tree = createTreeReader(db);
  const view: TreeView = { kind: "branch", branchId: input.branchId };
  const occupant = await tree.resolvePath(view, {
    contextSourceId: input.contextSourceId,
    path: filePath(input.dir, input.name, input.extension),
    as: "document",
  });
  if (occupant.kind === "ambiguous") return Err(ambiguous(occupant.nodes));
  if (occupant.kind === "found") {
    if (occupant.node.kind === "folder") return Err({ code: "conflict", occupantKind: "folder" });
    const binary = isStorageBackedDocument(occupant.node.document);
    if (input.node.kind === "binary") return Err({ code: "conflict", occupantKind: "file" });
    return Ok({ kind: "existing", documentId: occupant.node.document.id, binary });
  }

  // Folders a branch doesn't see yet: a hidden live folder at the location is joined (a
  // folder's use is implied by what is placed under it), else a new hidden one is made.
  const { contextSourceId } = input;
  const walk = await walkFolders(db, view, contextSourceId, input.dir, async (gap) => {
    const at = { contextSourceId, ...gap };
    return (await findHiddenFolder(db, at)) ?? (await insertFolder(db, at, { hidden: true }));
  });
  if (walk.kind === "occupied") {
    return Err(
      walk.occupant.kind === "ambiguous"
        ? ambiguous(walk.occupant.nodes)
        : { code: "conflict", occupantKind: "file" },
    );
  }
  if (walk.kind !== "walked") throw new Error("A branch's folder walk fills every gap");
  const slot: DocumentSlot = {
    contextSourceId,
    folderId: walk.folderId,
    name: input.name,
    extension: input.extension,
  };

  let documentId: DocumentId | null = null;
  let joined = false;
  if (input.node.kind === "tracked") {
    documentId =
      (
        await pickHiddenCandidate(db, slot, {
          excludeBranchId: input.branchId,
          lock: "createInBranch.afterCandidateLock",
          ...(input.repair ? { repair: input.repair } : {}),
        })
      )?.id ?? null;
    joined = documentId !== null;
  }
  if (documentId === null) {
    const id = input.node.kind === "binary" ? input.node.documentId : undefined;
    documentId = await insertDocumentRow(db, slot, input.node, {
      hidden: true,
      ...(id ? { id } : {}),
    });
    if (!documentId) throw new Error(`Hidden document ${slot.name} was not inserted`);
    if (input.node.kind === "tracked") await input.initializeEmptyContent(documentId);
  } else if (joined) {
    await input.repairContent(documentId);
  }

  await recordCreated(db, {
    branchId: input.branchId,
    documentId,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });
  if (input.node.kind === "tracked") await input.ensureDocumentDraft(documentId);
  return Ok({ kind: "created", documentId, joined });
}

function ambiguous(nodes: readonly { id: string }[]): CreateFault {
  return { code: "ambiguous", ids: nodes.map((node) => node.id) };
}

// ---------------------------------------------------------------------------------------
// Live creates (§6.3, §6.4)
// ---------------------------------------------------------------------------------------

/**
 * What a live create at this path would find, holding nothing (§6.3 step 1): a visible
 * occupant (a document, a folder of that name, or two nodes), the hidden candidate it
 * would reveal at its physical source, or nothing. The caller takes the candidate's live
 * lease before its transaction when the create carries content.
 */
export async function findLiveCreateCandidate(
  db: Database,
  at: { contextSourceId: ContextSourceId; dir: readonly string[]; name: string; extension: string },
): Promise<LiveCreateCandidate> {
  const tree = createTreeReader(db);
  const path = filePath(at.dir, at.name, at.extension);
  const occupant = await tree.resolvePath(LIVE_TREE, {
    contextSourceId: at.contextSourceId,
    path,
    as: "document",
  });
  if (occupant.kind === "found") {
    return { kind: "occupant", occupantKind: occupant.node.kind === "folder" ? "folder" : "file" };
  }
  if (occupant.kind === "ambiguous") return { kind: "occupant" };
  // The folder a live create lands in, without making anything: a visible folder, else a
  // hidden folder `ensureLiveFolderPath` would reveal.
  const walk = await walkFolders(db, LIVE_TREE, at.contextSourceId, at.dir, (gap) =>
    findHiddenFolder(db, { contextSourceId: at.contextSourceId, ...gap }),
  );
  if (walk.kind !== "walked") return { kind: "none" };
  const candidate = await pickHiddenCandidate(db, {
    contextSourceId: at.contextSourceId,
    folderId: walk.folderId,
    name: at.name,
    extension: at.extension,
  });
  return candidate
    ? { kind: "candidate", documentId: candidate.id, sourceId: candidate.sourceId }
    : { kind: "none" };
}

/** What a live create did; its caller refreshes the catalog from it. */
export type LiveCreateOutcome =
  | { kind: "revealed"; documentId: DocumentId; placed: PlaceResult }
  | { kind: "inserted"; documentId: DocumentId };

export type LiveCreateFault =
  | CreateFault
  /** What the create was planned against isn't what its locks find. */
  | { code: "candidate_changed" }
  /**
   * A unique key already holds the row: the caller-minted id. The live-location key would
   * answer the same, but the caller's namespace lock and occupancy check rule that out.
   */
  | { code: "row_exists" };

/** The live row a create inserts when it reveals nothing. */
export type LiveInsert = {
  node: TrackedNode;
  id?: DocumentId;
  markdown: string;
  provisionalName?: boolean;
};

/**
 * A live create at `slot` (§6.3 step 2, §6.4), under the claim its caller planned before
 * the transaction: reveal the hidden document at the path or the one named by id, or
 * insert the visible row `insert` describes. A claim the locks don't confirm is
 * `candidate_changed`. The caller holds the namespaces of the destination and of the
 * candidate's physical source, and has checked that no visible node sits at the path.
 */
export async function createLive(
  db: Database,
  input: {
    slot: DocumentSlot;
    claim: LiveClaim;
    insert: LiveInsert;
    /** Where a repair on touch is reported, to be warned about once this commits (§12.4). */
    repair?: Pick<HiddenNodeRepair, "report" | "tombstoneUnused">;
  },
): Promise<Result<LiveCreateOutcome, LiveCreateFault>> {
  const { claim } = input;
  let chosen: { id: DocumentId; sourceId: ContextSourceId } | null = null;
  if (claim.kind !== "mint") {
    chosen = await pickHiddenCandidate(db, input.slot, {
      lock: "createLive.afterCandidateLock",
      ...(input.repair ? { repair: input.repair } : {}),
    });
    const expected = claim.kind === "reveal" ? claim.reveal : null;
    const confirmed =
      claim.kind === "any" ||
      (expected === null
        ? chosen === null
        : chosen?.id === expected.documentId && chosen.sourceId === expected.sourceId);
    if (!confirmed) return Err({ code: "candidate_changed" });
  }
  if (!chosen) {
    const { node, markdown, id, provisionalName } = input.insert;
    const documentId = await insertDocumentRow(db, input.slot, node, {
      hidden: false,
      markdown,
      ...(id ? { id } : {}),
      ...(provisionalName ? { provisionalName } : {}),
    });
    return documentId ? Ok({ kind: "inserted", documentId }) : Err({ code: "row_exists" });
  }
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
      },
    ],
  });
  if (!placed.ok) {
    return Err(
      placed.error.code === "stale" ? { code: "candidate_changed" } : { code: "conflict" },
    );
  }
  return Ok({ kind: "revealed", documentId: chosen.id, placed: placed.value });
}

// ---------------------------------------------------------------------------------------
// The candidate picker (§6.2 step 3, §6.3 step 2, §12.4)
// ---------------------------------------------------------------------------------------

/**
 * The oldest valid hidden text document at the slot that some active branch uses
 * (excluding the ones `excludeBranchId` already uses). Unlocked, a look holding nothing.
 * With `lock`, every candidate's document lock is taken in one id-ordered pass before any
 * is chosen, then each is revalidated under its lock, and a candidate no active branch
 * uses is an inconsistent row, tombstoned here (repair on touch).
 */
async function pickHiddenCandidate(
  db: Database,
  slot: DocumentSlot,
  options: {
    excludeBranchId?: BranchId;
    lock?: TreeHookPoint;
    repair?: Pick<HiddenNodeRepair, "report" | "tombstoneUnused">;
  } = {},
): Promise<{ id: DocumentId; sourceId: ContextSourceId } | null> {
  const filter = options.excludeBranchId ? { excludeBranchId: options.excludeBranchId } : {};
  const candidates = await loadHiddenDocumentCandidates(db, slot, filter);
  const firstUsed = (rows: typeof candidates) => {
    const used = rows.find((candidate) => candidate.activeUses > 0);
    return used ? { id: used.id, sourceId: used.sourceId } : null;
  };
  if (!options.lock) return firstUsed(candidates);
  const ids = candidates.map((candidate) => candidate.id);
  await lockDocuments(db, ids);
  await treeHook(options.lock);
  if (candidates.length === 0) return null;
  const valid = await loadHiddenDocumentCandidates(db, slot, { ...filter, ids });
  const unused = valid
    .filter((candidate) => candidate.activeUses === 0)
    .map((candidate) => candidate.id);
  if (unused.length) {
    if (!options.repair) throw new Error("Candidate repair requires the removal protocol");
    const repaired = await options.repair.tombstoneUnused(unused, { keepFolders: true });
    options.repair.report(repaired, "create");
  }
  return firstUsed(valid);
}
