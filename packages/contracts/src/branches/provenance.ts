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
  /**
   * The chats with a change of an AI edit in each pending change, by the id Changes gives it
   * (read from the draft's text, so it names whoever's change the writer altered too).
   */
  members: Readonly<Record<string, readonly string[]>>;
  writers?: readonly {
    userId: string;
    inserted: readonly DraftItemRange[];
    deleted: readonly DraftItemRange[];
  }[];
};

/** The most drafts one evidence request may name; a client with more sends several. */
export const DRAFTS_PROVENANCE_MAX = 2000;
/** One request for the evidence of an owner's drafts: each draft a room on screen holds. */
export type DraftsProvenanceRequest = {
  owner: string;
  drafts: readonly { draftId: string; documentId: string }[];
};
/** Evidence by draft id; a draft that is not the owner's active draft of its document is absent. */
export type DraftsProvenanceResponse = { drafts: Record<string, DraftProvenanceResponse> };

/** The most drafts one draft-state read may name; a client with more sends several. */
export const DRAFT_STATES_MAX = 200;
/** The drafts a browser holds copies of. */
export type DraftStatesRequest = { draftIds: readonly string[] };
/** Why a draft closed: a Discard (a restore from Trash reopens it), or its document went (a restore may not). */
export type ClosedDraftCause = "discarded" | "document_removed";
/** Whether a draft is still open, or why it closed. */
export type DraftState = "open" | ClosedDraftCause;
/** The state of each named draft the account has; one it doesn't have is absent. */
export type DraftStatesResponse = { states: Record<string, DraftState> };
