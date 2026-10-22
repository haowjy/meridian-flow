/** Server-owned read-model for documents edited by one transcript turn. */

import type { BranchId } from "@meridian/contracts";
import type { TurnReceiptChip, TurnTreeLine } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { FileDestination } from "../../file-policy/index.js";
import type { TurnReceiptStateStore } from "./turn-receipt.js";

export type TurnEditedDocumentScope = "live" | "draft";

/**
 * Where a turn's edit landed: live, or the draft of the Work whose branch held it (from the
 * edit's draft row). A draft-scoped edit is read and reversed at that draft destination, so
 * it stays on the turn's receipt after a live delete its draft outlived (D79).
 */
export type TurnEditedDocumentId =
  | { documentId: DocumentId; scope: "live" }
  | {
      documentId: DocumentId;
      scope: "draft";
      work: { id: WorkId; handle: string | null };
      /** The Work's branches the turn's edits landed in, for inverse admission. */
      branchIds: BranchId[];
    };

export type TurnEditedDocument = TurnEditedDocumentId & { uri: string; tree?: TurnTreeLine };

/**
 * One of a turn's own moves, deletes or restores of a document, in `seq` order: live, or in the
 * branch of the Work `workId` names (a drafted entry, D26).
 */
export type TurnTreeEntry = {
  documentId: DocumentId;
  workId: WorkId | null;
  op: "create" | "move" | "delete" | "restore";
  shownAt: string | null;
  landedAt: string | null;
};

export type LiveLineageDocument = TurnEditedDocument & { scope: "live" };

/** The file-policy destination a turn's edit is read and reversed at. */
export function turnEditDestination(target: TurnEditedDocumentId): FileDestination {
  return target.scope === "draft"
    ? { kind: "draft", workId: target.work.id, workHandle: target.work.handle }
    : { kind: "live" };
}

export type TurnLiveLineageDocumentStore = {
  listLiveDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<DocumentId[]>;
  listEditedDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocumentId[]>;
  /** The turn's tree entries, live and drafted, ordered by `seq`. */
  listTreeEntriesForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnTreeEntry[]>;
};

export type TurnLiveLineageReadModel = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export function createTurnLiveLineageReadModel(deps: {
  store: TurnLiveLineageDocumentStore;
  receiptStore?: TurnReceiptStateStore;
  resolveDocumentUri(documentId: DocumentId): Promise<string | null>;
  /** The address a document holds or was deleted at: a surviving draft's location. */
  resolveLastDocumentUri(documentId: DocumentId): Promise<string | null>;
}): TurnLiveLineageReadModel {
  return {
    async listLiveDocumentsForTurn(threadId, turnId) {
      const documentIds = await deps.store.listLiveDocumentIdsForTurn(threadId, turnId);
      const documents = await resolveDocuments(
        documentIds.map((documentId) => ({ documentId, scope: "live" as const })),
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
      const documents = await resolveDocuments(targets, lines);
      return documents.map((document) => {
        const tree = lines.get(treeLineKey(document));
        return tree ? { ...document, tree } : document;
      });
    },

    async getTurnReceiptChip(threadId, turnId) {
      return deps.receiptStore?.getTurnReceiptChip(threadId, turnId) ?? null;
    },
  };

  /** A live document the turn deleted keeps its row at the address it was deleted from. */
  async function resolveDocuments(
    documentIds: readonly TurnEditedDocumentId[],
    lines: ReadonlyMap<string, TurnTreeLine> = new Map(),
  ): Promise<TurnEditedDocument[]> {
    const documents = await Promise.all(
      documentIds.map(async (document): Promise<TurnEditedDocument | null> => {
        const uri =
          document.scope === "draft" || lines.get(treeLineKey(document))?.op === "delete"
            ? await deps.resolveLastDocumentUri(document.documentId)
            : await deps.resolveDocumentUri(document.documentId);
        return uri ? { ...document, uri } : null;
      }),
    );
    return documents.filter((document): document is TurnEditedDocument => document !== null);
  }
}

/** A document's tree line is per destination: live, or one Work's branch. */
function treeLineKey(target: TurnEditedDocumentId | TurnTreeEntry): string {
  const workId =
    "workId" in target ? target.workId : target.scope === "draft" ? target.work.id : null;
  return workId ? `${target.documentId}:${workId}` : target.documentId;
}

/**
 * Each document's net tree line, per destination: deleted when the turn left it deleted, moved when it left it
 * living somewhere other than where the turn found it. A destination the entry didn't record
 * (a restore's) leaves the location as it was.
 */
function treeLines(entries: readonly TurnTreeEntry[]): Map<string, TurnTreeLine> {
  const folded = new Map<string, { from: string; at: string; living: boolean }>();
  for (const entry of entries) {
    const key = treeLineKey(entry);
    const state = folded.get(key) ?? {
      from: entry.shownAt ?? "",
      at: entry.shownAt ?? "",
      living: true,
    };
    if (entry.op === "delete") state.living = false;
    else {
      state.living = true;
      if (entry.op === "move" && entry.landedAt) state.at = entry.landedAt;
    }
    folded.set(key, state);
  }
  const lines = new Map<string, TurnTreeLine>();
  for (const [key, { from, at, living }] of folded) {
    if (!from) continue;
    if (!living) lines.set(key, { op: "delete", from });
    else if (at !== from) lines.set(key, { op: "move", from, to: at });
  }
  return lines;
}
