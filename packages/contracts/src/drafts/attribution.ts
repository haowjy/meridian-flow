/** Wire shapes for the chat attribution hint and the draft dock's draft list. */
import type { DraftItemKey } from "../ids.js";
import type { ThreadDraftListItem } from "./review.js";

/** `[client, clock, length]` of a run of Yjs items. */
export type AttributionItemRange = [client: number, clock: number, length: number];

/** One AI edit part pending in a draft, as the browser's matcher reads it. */
export interface DraftAttributionEdit {
  threadId: string;
  title: string;
  turnId: string;
  /** The tool call that wrote the part, when its journal row recorded one. */
  toolCallId?: string;
  /** ISO time of the edit; the list is latest first. */
  at: string;
  inserted: AttributionItemRange[];
  deleted: AttributionItemRange[];
}

/** `GET …/draft/attribution?itemKey=`: a hint for naming chats on changes; nothing gates on it. */
export interface DraftAttribution {
  itemKey: DraftItemKey;
  edits: DraftAttributionEdit[];
}

/** `GET /api/threads/:threadId/draft-files`: the listed items whose pending AI edits include this chat. */
export interface ThreadDraftFilesResponse {
  drafts: ThreadDraftListItem[];
}
