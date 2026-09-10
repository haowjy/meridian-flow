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

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
}
