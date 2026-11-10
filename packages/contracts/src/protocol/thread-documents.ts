/**
 * Purpose: Defines JSON-natural recent-document and live-lineage DTOs.
 * Why independent: Chat rail data is shared by server routes and frontend query consumers.
 */
import type { DraftOwnerKey } from "../branches/owner.js";
import type { Filetype, YjsTrackedSchemaType } from "./filetype.js";
import type { DocumentFileType } from "./http-types.js";

export type ThreadDocumentRelationship = "editing" | "reading" | "created";

export type ThreadDocumentKind = "tracked" | "binary";

export interface ThreadRecentDocumentItem {
  threadId: string;
  documentId: string;
  name: string;
  extension: string;
  sizeBytes: number | null;
  editable: boolean;
  filetype: Filetype | null;
  schemaType: YjsTrackedSchemaType | null;
  fileType: DocumentFileType | null;
  mimeType: string | null;
  kind: ThreadDocumentKind;
  touchedAt: string;
  updatedAt: string;
  /** The chat or one of its subagents made an agent write to this document (not a read). */
  edited: boolean;
}

export interface ListThreadRecentDocumentsResponse {
  documents: ThreadRecentDocumentItem[];
}

/**
 * The chats that worked on a document, and the pages it links to. `chats` are top-level chats of
 * the project the reader owns, newest first, at most 20; a subagent's work is credited to the
 * chat that spawned it, a fork's to the fork.
 */
export interface DocumentRelated {
  chats: {
    chatId: string;
    title: string;
    workId: string | null;
    touchedAt: string;
    /** An agent write by this chat or its subagents is recorded; undo and revert do not count. */
    edited: boolean;
  }[];
  /** Pages this document's Live text links to, with how often. */
  mentions: { documentId: string; occurrences: number }[];
}

/**
 * What a turn did to where a document is, net of its own moves: deleted it, moved it, or
 * copied it there from another document. Locations are context URIs as they were when the
 * turn ran.
 */
export type TurnTreeLine =
  | { op: "delete"; from: string }
  | { op: "move"; from: string; to: string }
  /** `from` is the source document the copy read; `to` is where the copy landed. */
  | { op: "copy"; from: string; to: string };

export type TurnLiveLineageDocumentItem = {
  documentId: string;
  /** Where the document is now; where it was deleted from when it is deleted. */
  uri: string;
  /** Slash-prefixed display path derived from the canonical context URI. */
  path: string;
  /** Present when the turn moved or deleted the document. */
  tree?: TurnTreeLine;
} & (
  | { scope: "live" }
  /** The edit landed in a draft: `owner` names the Work or lineage whose branch held it. */
  | { scope: "draft"; owner: DraftOwnerKey }
);

export type TurnReceiptState =
  | "live-active"
  | "live-reversed"
  | "work-active"
  | "work-reversed"
  | "cant_undo_dependent"
  | "expired";

export type TurnReceiptControl = "undo" | "redo" | "view_change";

export interface TurnReceiptChip {
  skips?: import("./write-reversal.js").TurnInverseSkip[];
  state: TurnReceiptState;
  control: TurnReceiptControl;
}

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
}
