/** Query port for durable agent-edit mutation metadata. */
export interface ActiveTurnSummary {
  turnId: string;
  count: number;
  minSeq: number;
}

export interface MutationStore {
  /** Latest turn with active mutations for this document/thread, if one exists. */
  latestActiveTurn(documentId: string, threadId: string): Promise<string | undefined>;

  /** Active mutation counts and earliest retained sequence per turn. */
  activeTurnSummary(documentId: string, threadId: string): Promise<ActiveTurnSummary[]>;
}
