/**
 * Purpose: Defines JSON-natural thread document rail DTOs for uploads and recent document APIs.
 * Why independent: Chat rail data is shared by server routes and frontend query consumers.
 */
import type { Filetype } from "./filetype.js";
import type { DocumentFileType } from "./http-types.js";
import type { YjsTrackedSchemaType } from "./yjs-multiplex.js";

export type ThreadDocumentRelationship = "editing" | "reading" | "created";

export type ThreadDocumentKind = "tracked" | "binary";

export interface ThreadUploadDocumentItem {
  threadId: string;
  documentId: string;
  relationship: ThreadDocumentRelationship;
  name: string;
  extension: string;
  sizeBytes: number | null;
  editable: boolean;
  filetype: Filetype | null;
  schemaType: YjsTrackedSchemaType | null;
  fileType: DocumentFileType | null;
  mimeType: string | null;
  kind: ThreadDocumentKind;
  firstTouchedAt: string;
  lastTouchedAt: string;
  updatedAt: string;
}

export interface UploadThreadDocumentResponse {
  upload: ThreadUploadDocumentItem;
}

export interface ListThreadUploadsResponse {
  uploads: ThreadUploadDocumentItem[];
}

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
