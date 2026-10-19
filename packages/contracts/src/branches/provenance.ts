/** Snapshot-bounded draft authorship evidence. Clock ranges are Yjs [client, clock, length] tuples. */
export type DraftItemRange = readonly [client: number, clock: number, length: number];
export type DraftProvenancePart = {
  threadId: string | null;
  turnId: string | null;
  toolCallId?: string;
  inserted: readonly DraftItemRange[];
  deleted: readonly DraftItemRange[];
  owner: {
    threadId: string;
    title: string;
    reveal: { threadId: string; turnId: string; toolCallId?: string; subagentThreadId?: string };
  } | null;
};
export type DraftProvenanceResponse = {
  userId: string;
  snapshot: number[];
  parts: readonly DraftProvenancePart[];
  writers?: readonly {
    userId: string;
    inserted: readonly DraftItemRange[];
    deleted: readonly DraftItemRange[];
  }[];
};
