/** JSON contracts for authoritative project upload intake. */
import type { ContextEntryValidationReason } from "../context-entry-validation.js";
import type { CanonicalContextUri } from "../context-uri.js";
import type { Filetype } from "./filetype.js";

/**
 * Who an upload belongs to. A chat's attach waits in its flat `uploads` source for a send; a
 * source upload (a file dropped into a document) goes straight into `assets/` of the document's
 * own source and belongs to nobody.
 */
export type UploadOwner =
  | { kind: "chat"; projectId: string; chatId: string }
  | { kind: "source"; projectId: string };

/** The largest file an upload takes. The browser checks it before sending; the server stays the authority. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** What a browser sends to start an upload: the file's exact size and type, never its bytes. The chat is in the query. */
export interface StartUploadInput {
  intakeId: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

/** A signed PUT the browser sends to the store. `headers` go as given; the browser sets `Content-Length`. */
export interface UploadSignedPut {
  url: string;
  headers: Record<string, string>;
}

/** Where an upload stands when it is started or started again. */
export type UploadStart =
  | { state: "reserved"; documentId: string; locationRevision: string; put: UploadSignedPut }
  /** The bytes are in the store and checked: finish, with no PUT. */
  | { state: "stored"; documentId: string; locationRevision: string }
  | { state: "finalized"; result: UploadIntakeResult };

export interface UploadIntakeResult {
  documentId: string;
  uri: CanonicalContextUri;
  fileType: Filetype;
  locationRevision: string;
}

export type UploadIntakeError =
  | { code: "owner_unavailable" | "idempotency_conflict" | "storage_failed" }
  | { code: "too_large"; limitBytes: number }
  /** The stored object's length differs from the size the writer declared. */
  | { code: "size_mismatch" }
  /** Finish found nothing at the upload URL: the PUT hasn't happened, or the URL expired. */
  | { code: "not_uploaded" }
  | { code: "invalid_filename"; reason: ContextEntryValidationReason; character?: string };

export type UploadIntakeErrorCode = UploadIntakeError["code"];

export interface DeleteDraftUploadInput {
  intakeId: string;
  documentId: string;
  uri: CanonicalContextUri;
  expectedRevision: string;
}

export type DeleteDraftUploadResult =
  | { kind: "deleted" }
  | { kind: "already_deleted" }
  | { kind: "already_used" }
  | { kind: "identity_mismatch" };
