/** In-memory draft sync-state adapter with the same generation fence as Postgres. */
import type { SyncState, SyncStateStore } from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DraftStore } from "../../domain/drafts.js";

export function createInMemoryDraftSyncStateStore(input: {
  draftStore: Pick<DraftStore, "getActiveDraft">;
}): SyncStateStore {
  const rows = new Map<string, { acceptGeneration: number; state: SyncState }>();

  return {
    async load(documentId, threadId) {
      const draft = await input.draftStore.getActiveDraft({
        documentId: documentId as DocumentId,
        threadId: threadId as ThreadId,
      });
      if (!draft) return null;
      const row = rows.get(key(documentId, threadId, draft.id));
      if (!row || row.acceptGeneration !== draft.acceptGeneration) return null;
      return copyState(row.state);
    },

    async save(documentId, threadId, state) {
      const draft = await input.draftStore.getActiveDraft({
        documentId: documentId as DocumentId,
        threadId: threadId as ThreadId,
      });
      if (!draft) return;
      rows.set(key(documentId, threadId, draft.id), {
        acceptGeneration: draft.acceptGeneration,
        state: copyState(state),
      });
    },

    async delete(documentId, threadId) {
      const draft = await input.draftStore.getActiveDraft({
        documentId: documentId as DocumentId,
        threadId: threadId as ThreadId,
      });
      if (!draft) return;
      rows.delete(key(documentId, threadId, draft.id));
    },
  };
}

function key(documentId: string, threadId: string, draftId: string): string {
  return `${documentId}:${threadId}:${draftId}`;
}

function copyState(state: SyncState): SyncState {
  return {
    stateVector: new Uint8Array(state.stateVector),
    syncedSnapshot: new Uint8Array(state.syncedSnapshot),
    committedSnapshot: new Uint8Array(state.committedSnapshot),
  };
}
