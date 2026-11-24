import type {
  FrontierLookup,
  FrontierRooms,
  ObservationFrontier,
  ReplyMutations,
  ShownBlock,
  StoredEvidence,
} from "../../../shared/model-evidence.js";

export interface DocumentEvidence {
  resultStored(evidence: StoredEvidence): Promise<void>;
  latestFrontier(
    documentId: string,
    blockIds: readonly string[],
  ): Promise<ObservationFrontier | null>;
  frontiersIn(rooms: FrontierRooms, blockIds: readonly string[]): Promise<RecordedFrontier[]>;
}

export type RecordedFrontier = { blockId: string; recordedSeq: number; snapshot: Uint8Array };

export interface FrontierLookups {
  recording: FrontierLookup;
  planning: FrontierLookup;
  planningShown(documentId: string): Promise<readonly ShownBlock[]>;
  credited(): readonly string[];
  reply: ReplyMutations;
}
