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

/**
 * What a turn did to where a document is, net of its own moves: deleted it, or moved it.
 * Locations are context URIs as they were when the turn ran.
 */
export type TurnTreeLine =
  | { op: "delete"; from: string }
  | { op: "move"; from: string; to: string };

export interface TurnLiveLineageDocumentItem {
  documentId: string;
  /** Where the document is now; where it was deleted from when it is deleted. */
  uri: string;
  /** Slash-prefixed display path derived from the canonical context URI. */
  path: string;
  scope: "live" | "draft";
  /** Present when the turn moved or deleted the document. */
  tree?: TurnTreeLine;
}

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
