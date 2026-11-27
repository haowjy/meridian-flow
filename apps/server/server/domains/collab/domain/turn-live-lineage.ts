import type { DraftId } from "@meridian/contracts";
import type { TurnReceiptChip, TurnTreeLine } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { FileDestination } from "../../file-policy/index.js";
import type { TurnReceiptStateStore } from "./turn-receipt.js";

export type TurnEditedDocumentScope = "live" | "draft";

export type TurnEditedDocumentId = (
  | { documentId: DocumentId; scope: "live" }
  | { documentId: DocumentId; scope: "draft"; draft: DraftId; ownerHandle: string | null }
) & {
  block?: string;
};

export type TurnEditedDocument = TurnEditedDocumentId & {
  uri: string;
  tree?: TurnTreeLine;
  placement?: TreePlacement;
  removed?: true;
};

export type TurnTreeEntry = {
  documentId: DocumentId;
  folder: boolean;
  draft: DraftId | null;
  op: "create" | "move" | "delete" | "restore";
  shownAt: string | null;
  landedAt: string | null;
  copiedFrom: string | null;
  undone: boolean;
};

export type LiveLineageDocument = TurnEditedDocument & { scope: "live" };

export type TurnTreeFolder = {
  nodeId: string;
  draft: DraftId | null;
  at: string;
  tree?: TurnTreeLine;
  placement?: TreePlacement;
};

export type TurnFolderTarget = { nodeId: string; draft: DraftId | null; shownAt: string };

export type TreePlacement = readonly string[];

export type TreePlace = { placement: TreePlacement; uri?: string };

export function turnEditDestination(target: TurnEditedDocumentId): FileDestination {
  return target.scope === "draft"
    ? { kind: "draft", draftId: target.draft, ownerHandle: target.ownerHandle }
    : { kind: "live" };
}

export type TurnLiveLineageDocumentStore = {
  listLiveDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<DocumentId[]>;
  listEditedDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocumentId[]>;
  listFolderTargetsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnFolderTarget[]>;
  placesOf(
    nodes: readonly { nodeId: string; draftId: string | null }[],
  ): Promise<Map<string, TreePlace>>;
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
  resolveLastDocumentUri(documentId: DocumentId, draftId?: DraftId): Promise<string | null>;
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
      const draftOf = (document: TurnEditedDocument) =>
        document.scope === "draft" ? document.draft : null;
      const places = await deps.store.placesOf(
        documents.map((document) => ({
          nodeId: document.documentId,
          draftId: draftOf(document),
        })),
      );
      return documents.map((document) => {
        const tree = lines.get(treeLineKey(document));
        const placement = places.get(`${document.documentId}:${draftOf(document)}`)?.placement;
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
      const places = await deps.store.placesOf(
        folders.map((folder) => ({ nodeId: folder.nodeId, draftId: folder.draft })),
      );
      return folders.map(({ shownAt, ...folder }) => {
        const key = treeLineKey({ documentId: folder.nodeId, draft: folder.draft });
        const tree = lines.get(key);
        const place = places.get(`${folder.nodeId}:${folder.draft}`);
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
            document.scope === "draft" ? document.draft : undefined,
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

function createAddresses(entries: readonly TurnTreeEntry[]): ReadonlyMap<string, string> {
  return new Map(
    entries.flatMap((entry) =>
      entry.op === "create" && entry.shownAt ? [[treeLineKey(entry), entry.shownAt]] : [],
    ),
  );
}

function treeLineKey(
  target: TurnEditedDocumentId | { documentId: string; draft: DraftId | null },
): string {
  const draft = "scope" in target ? (target.scope === "draft" ? target.draft : null) : target.draft;
  return draft ? `${target.documentId}:${draft}` : target.documentId;
}

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
