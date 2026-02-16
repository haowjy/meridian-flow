import { create } from "zustand";

export type CollabConnectionState = "connected" | "syncing" | "disconnected";

interface CollabStore {
  stateByDocumentId: Record<string, CollabConnectionState>;
  setState: (documentId: string, state: CollabConnectionState) => void;
  clearState: (documentId: string) => void;
}

export const useCollabStore = create<CollabStore>()((set) => ({
  stateByDocumentId: {},

  setState: (documentId, state) => {
    set((current) => ({
      stateByDocumentId: {
        ...current.stateByDocumentId,
        [documentId]: state,
      },
    }));
  },

  clearState: (documentId) => {
    set((current) => {
      const next = { ...current.stateByDocumentId };
      delete next[documentId];
      return { stateByDocumentId: next };
    });
  },
}));
