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

/** One request for the evidence of an owner's drafts: each draft a room on screen holds. */
export type DraftsProvenanceRequest = {
  owner: string;
  drafts: readonly { draftId: string; documentId: string }[];
};
/** Evidence by draft id; a draft that is not the owner's active draft of its document is absent. */
export type DraftsProvenanceResponse = { drafts: Record<string, DraftProvenanceResponse> };
