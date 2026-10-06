/**
 * Purpose: Defines JSON-natural recent-document and live-lineage DTOs.
 * Why independent: Chat rail data is shared by server routes and frontend query consumers.
 */
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
}

export interface ListThreadRecentDocumentsResponse {
  documents: ThreadRecentDocumentItem[];
}

export interface TurnLiveLineageDocumentItem {
  documentId: string;
  uri: string;
  /** Slash-prefixed display path derived from the canonical context URI. */
  path: string;
  scope: "live" | "draft";
}

export type TurnReceiptState =
  | "live-active"
  | "live-reversed"
  | "branch-active"
  | "branch-reversed"
  | "work-active"
  | "work-reversed"
  | "rollback-pending"
  | "cant_undo_dependent"
  | "expired";

export type TurnReceiptControl = "undo" | "redo" | "view_change";

export interface TurnReceiptChip {
  state: TurnReceiptState;
  control: TurnReceiptControl;
}

/**
 * One move or delete the model made in the turn, on the write handle its tool
 * result names (`w<wId>` on `documentId`). `reversed` once an undo, a turn
 * undo or the writer's restore put it back.
 */
export interface TurnNamespaceChangeItem {
  documentId: string;
  wId: number;
  kind: "move" | "delete";
  /** Where the document was: a move's old location, or where it was deleted from. */
  fromUri: string;
  /** A move's new location. */
  toUri: string | null;
  status: "active" | "reversed";
}

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
  namespaceChanges: TurnNamespaceChangeItem[];
}

/** POST …/turns/:turnId/restore-delete: 200 `restored`, 409 for the other two. */
export type RestoreAgentDeleteResponse =
  | { status: "restored"; documentId: string; uri: string }
  /** Something else is at the document's old location now. */
  | { status: "location_taken"; uri: string }
  /** The folder it was in is gone. */
  | { status: "folder_missing"; uri: string };
