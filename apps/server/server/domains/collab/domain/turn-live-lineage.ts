/** Server-owned read-model for documents edited by one transcript turn. */

import {
  type BranchId,
  type DraftOwner,
  type DraftOwnerKey,
  draftOwnerKey,
} from "@meridian/contracts";
import type { TurnReceiptChip, TurnTreeLine } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { FileDestination } from "../../file-policy/index.js";
import type { TurnReceiptStateStore } from "./turn-receipt.js";

export type TurnEditedDocumentScope = "live" | "draft";

/**
 * Where a turn's edit landed: live, or the draft of the owner whose branch held it (from the
 * edit's draft row). A draft-scoped edit is read and reversed at that draft destination, so
 * it stays on the turn's receipt after a live delete its draft outlived.
 */
export type TurnEditedDocumentId =
  | { documentId: DocumentId; scope: "live" }
  | {
      documentId: DocumentId;
      scope: "draft";
      owner: DraftOwner;
      ownerHandle: string | null;
      /** The owner's branches the turn's edits landed in, for inverse admission. */
      branchIds: BranchId[];
    };

export type TurnEditedDocument = TurnEditedDocumentId & {
  uri: string;
  tree?: TurnTreeLine;
  placement?: TreePlacement;
  /** The current destination is gone; authorize this immutable target where it restores. */
  removed?: true;
};

/**
 * One of a turn's own creates, moves, deletes or restores of a node (a document, or a `folder`),
 * in `seq` order: live, or in the branch of the owner `ownerKey` names (a drafted entry).
 */
export type TurnTreeEntry = {
  documentId: DocumentId;
  folder: boolean;
  ownerKey: DraftOwnerKey | null;
  op: "create" | "move" | "delete" | "restore";
  shownAt: string | null;
  landedAt: string | null;
  /**
   * The source a create copied, from its receipt or document metadata, so the turn's line can
   * say it copied rather than only naming where it ended up. Null on
   * every other entry: a copy moved later in the same turn keeps this on its create.
   */
  copiedFrom: string | null;
  /**
   * The model's own undo took this change back: it names an address but is no longer one of the
   * reply's changes. A card's Undo doesn't count: the card still says what the reply did.
   */
  undone: boolean;
};

export type LiveLineageDocument = TurnEditedDocument & { scope: "live" };

/**
 * A folder a turn changed, in the destination (live, or an owner's branch) the change went to:
 * it has no document, so it is named where the change left it (`at`: a clash's " (2)" included),
 * with its tree line.
 */
export type TurnTreeFolder = {
  nodeId: string;
  ownerKey: DraftOwnerKey | null;
  at: string;
  tree?: TurnTreeLine;
  placement?: TreePlacement;
};

/** A folder the turn changed, by the path the model gave, and the branch it was drafted in. */
export type TurnFolderTarget = {
  nodeId: string;
  ownerKey: DraftOwnerKey | null;
  branchId: string | null;
  shownAt: string;
};

/**
 * Where a row's node sits in the tree that shows it (live, or a Work's branch): its source, then
 * the rank and id of each node on its path from the top of the source down. Compared in order
 * after the source's section, it is the file tree's own order. Absent for a node that view
 * doesn't place.
 */
export type TreePlacement = readonly string[];

/** A node's placement in a view, and a folder's address there. */
export type TreePlace = { placement: TreePlacement; uri?: string };

/** The file-policy destination a turn's edit is read and reversed at. */
export function turnEditDestination(target: TurnEditedDocumentId): FileDestination {
  return target.scope === "draft"
    ? { kind: "draft", owner: target.owner, ownerHandle: target.ownerHandle }
    : { kind: "live" };
}

export type TurnLiveLineageDocumentStore = {
  listLiveDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<DocumentId[]>;
  listEditedDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocumentId[]>;
  listFolderTargetsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnFolderTarget[]>;
  /** Each node's place in the view `branchId` names (null: live), keyed `node:branch`. */
  placesOf(
    nodes: readonly { nodeId: string; branchId: string | null }[],
  ): Promise<Map<string, TreePlace>>;
  /** The turn's tree entries, live and drafted, ordered by `seq`. */
  listTreeEntriesForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnTreeEntry[]>;
};

export type TurnLiveLineageReadModel = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  listFoldersForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnTreeFolder[]>;
  getDocumentAndTreeChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export function createTurnLiveLineageReadModel(deps: {
  store: TurnLiveLineageDocumentStore;
  receiptStore?: TurnReceiptStateStore;
  resolveDocumentUri(documentId: DocumentId): Promise<string | null>;
  /** The address a document holds or was deleted at: a surviving draft's location. */
  resolveLastDocumentUri(documentId: DocumentId, branchId?: BranchId): Promise<string | null>;
}): TurnLiveLineageReadModel {
  return {
    async listLiveDocumentsForTurn(threadId, turnId) {
      const [documentIds, entries] = await Promise.all([
        deps.store.listLiveDocumentIdsForTurn(threadId, turnId),
        deps.store.listTreeEntriesForTurn(threadId, turnId),
      ]);
      const documents = await resolveDocuments(
        documentIds.map((documentId) => ({ documentId, scope: "live" as const })),
        new Map(),
        createAddresses(entries),
      );
      return documents.filter(
        (document): document is LiveLineageDocument => document.scope === "live",
      );
    },

    async listEditedDocumentsForTurn(threadId, turnId) {
      const [targets, entries] = await Promise.all([
        deps.store.listEditedDocumentIdsForTurn(threadId, turnId),
        deps.store.listTreeEntriesForTurn(threadId, turnId),
      ]);
      const lines = treeLines(entries);
      const documents = await resolveDocuments(targets, lines, createAddresses(entries));
      const branchOf = (document: TurnEditedDocument) =>
        document.scope === "draft" ? (document.branchIds.at(-1) ?? null) : null;
      const places = await deps.store.placesOf(
        documents.map((document) => ({
          nodeId: document.documentId,
          branchId: branchOf(document),
        })),
      );
      return documents.map((document) => {
        const tree = lines.get(treeLineKey(document));
        const placement = places.get(`${document.documentId}:${branchOf(document)}`)?.placement;
        return {
          ...document,
          ...(tree ? { tree } : {}),
          ...(placement ? { placement } : {}),
        };
      });
    },

    async listFoldersForTurn(threadId, turnId) {
      const [folders, entries] = await Promise.all([
        deps.store.listFolderTargetsForTurn(threadId, turnId),
        deps.store.listTreeEntriesForTurn(threadId, turnId),
      ]);
      const lines = treeLines(entries);
      const made = createAddresses(entries);
      const places = await deps.store.placesOf(folders);
      return folders.map(({ shownAt, branchId, ...folder }) => {
        const key = treeLineKey({ documentId: folder.nodeId, ownerKey: folder.ownerKey });
        const tree = lines.get(key);
        const place = places.get(`${folder.nodeId}:${branchId}`);
        // Where the folder is now; the turn's own words only for one its view no longer places.
        const at =
          place?.uri ??
          (tree ? (tree.op === "delete" ? tree.from : tree.to) : (made.get(key) ?? shownAt));
        return {
          ...folder,
          at,
          ...(tree ? { tree } : {}),
          ...(place ? { placement: place.placement } : {}),
        };
      });
    },

    async getDocumentAndTreeChip(threadId, turnId) {
      return deps.receiptStore?.getDocumentAndTreeChip(threadId, turnId) ?? null;
    },
  };

  /** A removed live document keeps its row at its last address, including an undone create. */
  async function resolveDocuments(
    documentIds: readonly TurnEditedDocumentId[],
    lines: ReadonlyMap<string, TurnTreeLine> = new Map(),
    createdAt: ReadonlyMap<string, string> = new Map(),
  ): Promise<TurnEditedDocument[]> {
    const documents = await Promise.all(
      documentIds.map(async (document): Promise<TurnEditedDocument | null> => {
        const useLastAddress =
          document.scope === "draft" || lines.get(treeLineKey(document))?.op === "delete";
        if (useLastAddress) {
          const uri = await deps.resolveLastDocumentUri(
            document.documentId,
            document.scope === "draft" ? document.branchIds[0] : undefined,
          );
          if (uri) return { ...document, uri };
          const removedAt = createdAt.get(treeLineKey(document));
          return removedAt ? { ...document, uri: removedAt, removed: true } : null;
        }
        const uri = await deps.resolveDocumentUri(document.documentId);
        if (uri) return { ...document, uri };
        const removedAt =
          (await deps.resolveLastDocumentUri(document.documentId)) ??
          createdAt.get(treeLineKey(document));
        return removedAt ? { ...document, uri: removedAt, removed: true } : null;
      }),
    );
    return documents.filter((document): document is TurnEditedDocument => document !== null);
  }
}

/** A create's recorded address survives even when it was drafted and never became live, or undone. */
function createAddresses(entries: readonly TurnTreeEntry[]): ReadonlyMap<string, string> {
  return new Map(
    entries.flatMap((entry) =>
      entry.op === "create" && entry.shownAt ? [[treeLineKey(entry), entry.shownAt]] : [],
    ),
  );
}

/** A document's tree line is per destination: live, or one owner's branch. */
function treeLineKey(
  target: TurnEditedDocumentId | { documentId: string; ownerKey: DraftOwnerKey | null },
): string {
  const ownerKey =
    "ownerKey" in target
      ? target.ownerKey
      : target.scope === "draft"
        ? draftOwnerKey(target.owner)
        : null;
  return ownerKey ? `${target.documentId}:${ownerKey}` : target.documentId;
}

/**
 * Each node's net tree line, per destination: deleted when the turn left it deleted, copied
 * when the turn created it from another document, moved when it left it living somewhere other
 * than where the turn found it, or moved in place when it only changed position (`to` equals
 * `from`). A destination the entry didn't record (a restore's) leaves the location as it was.
 */
function treeLines(entries: readonly TurnTreeEntry[]): Map<string, TurnTreeLine> {
  const folded = new Map<
    string,
    { from: string; at: string; living: boolean; repositioned: boolean; copiedFrom: string | null }
  >();
  for (const entry of entries) {
    if (entry.undone) continue;
    const key = treeLineKey(entry);
    const state = folded.get(key) ?? {
      from: entry.shownAt ?? "",
      at: entry.shownAt ?? "",
      living: true,
      repositioned: false,
      copiedFrom: null,
    };
    if (entry.op === "delete") state.living = false;
    else {
      state.living = true;
      if (entry.op === "create" && entry.copiedFrom) state.copiedFrom = entry.copiedFrom;
      if (entry.op === "move" && entry.landedAt) {
        // A move that kept the path it was shown at changed only the position among siblings.
        if (entry.landedAt === entry.shownAt) state.repositioned = true;
        state.at = entry.landedAt;
      }
    }
    folded.set(key, state);
  }
  const lines = new Map<string, TurnTreeLine>();
  for (const [key, { from, at, living, repositioned, copiedFrom }] of folded) {
    if (!from) continue;
    if (!living) lines.set(key, { op: "delete", from });
    else if (copiedFrom) lines.set(key, { op: "copy", from: copiedFrom, to: at });
    else if (at !== from || repositioned) lines.set(key, { op: "move", from, to: at });
  }
  return lines;
}
