import { create } from "zustand";
import type { DocumentSessionStatus } from "@/core/cm6-collab/sync/DocumentSessionManager";
import type {
  Proposal,
  ProposalGroupAcceptResultEvent,
  ProposalStateSnapshot,
} from "@/core/cm6-collab";

export type CollabConnectionState = "connected" | "syncing" | "disconnected";

const EMPTY_PROPOSALS = new Map<string, Proposal>();

export interface DocumentProposalState {
  proposals: Map<string, Proposal>;
  lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null;
}

export const EMPTY_DOCUMENT_PROPOSAL_STATE: DocumentProposalState = {
  proposals: EMPTY_PROPOSALS,
  lastGroupAcceptResult: null,
};

interface CollabStore {
  stateByDocumentId: Record<string, CollabConnectionState>;
  proposalStateByDocumentId: Record<string, DocumentProposalState>;
  setState: (documentId: string, state: CollabConnectionState) => void;
  setStateFromSessionStatus: (
    documentId: string,
    status: DocumentSessionStatus,
  ) => void;
  setProposalState: (documentId: string, state: ProposalStateSnapshot) => void;
  clearState: (documentId: string) => void;
}

export function mapSessionStatusToConnectionState(
  status: DocumentSessionStatus,
): CollabConnectionState {
  if (status === "connected") {
    return "connected";
  }
  if (status === "disconnected") {
    return "disconnected";
  }
  return "syncing";
}

export const useCollabStore = create<CollabStore>()((set) => ({
  stateByDocumentId: {},
  proposalStateByDocumentId: {},

  setState: (documentId, state) => {
    set((current) => ({
      stateByDocumentId: {
        ...current.stateByDocumentId,
        [documentId]: state,
      },
    }));
  },

  setStateFromSessionStatus: (documentId, status) => {
    set((current) => ({
      stateByDocumentId: {
        ...current.stateByDocumentId,
        [documentId]: mapSessionStatusToConnectionState(status),
      },
    }));
  },

  setProposalState: (documentId, state) => {
    set((current) => ({
      proposalStateByDocumentId: {
        ...current.proposalStateByDocumentId,
        [documentId]: {
          proposals: state.proposals,
          lastGroupAcceptResult: state.lastGroupAcceptResult,
        },
      },
    }));
  },

  clearState: (documentId) => {
    set((current) => {
      const nextStateByDocumentId = { ...current.stateByDocumentId };
      delete nextStateByDocumentId[documentId];

      const nextProposalStateByDocumentId = {
        ...current.proposalStateByDocumentId,
      };
      delete nextProposalStateByDocumentId[documentId];

      return {
        stateByDocumentId: nextStateByDocumentId,
        proposalStateByDocumentId: nextProposalStateByDocumentId,
      };
    });
  },
}));
