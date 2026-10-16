/** Wire shapes for who wrote each review change (the attribution read) and the draft dock's draft list. */
import type { DraftItemKey } from "../ids.js";
import type { ThreadDraftListItem } from "./review.js";

/** `[client, clock, length]` of a run of Yjs items. */
export type AttributionItemRange = [client: number, clock: number, length: number];

/**
 * Who wrote part of a review change: the draft's human (`userId` is the project's user today; the card
 * says "You") or an AI write, by the thread that made it (a subagent's own thread for its writes).
 */
export type Author =
  | { kind: "user"; userId: string }
  | { kind: "thread"; threadId: string; turnId: string; toolCallId?: string };

/** Where a write's link lands in the conversation the writer knows it by. */
export interface DraftEditReveal {
  threadId: string;
  turnId: string;
  /** The tool call to reveal; for a subagent's write, the spawn call. */
  toolCallId?: string;
  /** Set for a subagent's write: the spawn row to open (the outermost child of `threadId` on its path). */
  subagentThreadId?: string;
}

/**
 * The conversation a write belongs to: its own thread, or for a subagent's write the nearest primary
 * ancestor. The draft dock, chat-scoped Apply and Discard and the draft-files list read `threadId`.
 */
export interface DraftEditOwner {
  threadId: string;
  title: string;
  reveal: DraftEditReveal;
}

/** One AI edit part pending in a draft, as the browser's classifier reads it. */
export interface DraftAttributionEdit {
  /** The thread that wrote: a subagent's own thread for its writes. */
  threadId: string;
  /** That thread's title (a subagent's task title). */
  title: string;
  turnId: string;
  /** The tool call that wrote the part, when its journal row recorded one. */
  toolCallId?: string;
  owner: DraftEditOwner;
  /** ISO time of the edit; the list is latest first. */
  at: string;
  inserted: AttributionItemRange[];
  deleted: AttributionItemRange[];
}

/**
 * `GET …/draft/attribution?itemKey=`: what the browser's classifier needs to say who wrote each change.
 * `userId` owns the browser clients (the project's one user today). Undo-restoration links are not here:
 * they live in the draft doc itself (`recordRestorations`).
 */
export interface DraftAttribution {
  itemKey: DraftItemKey;
  userId: string;
  edits: DraftAttributionEdit[];
}

/** `GET /api/threads/:threadId/draft-files`: the listed items whose pending AI edits include this chat. */
export interface ThreadDraftFilesResponse {
  drafts: ThreadDraftListItem[];
}
