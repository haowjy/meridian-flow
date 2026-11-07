/** JSON contracts for authoritative project upload intake. */
import type { ContextEntryValidationReason } from "../context-entry-validation.js";
import type { CanonicalContextUri } from "../context-uri.js";
import type { Filetype } from "./filetype.js";

/** The chat (a primary thread) a file was attached to; its row may not exist yet. */
export type UploadOwner = { kind: "chat"; projectId: string; chatId: string };

/** The largest file an upload takes. The browser checks it before sending; the server stays the authority. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface UploadIntakeResult {
  documentId: string;
  uri: CanonicalContextUri;
  fileType: Filetype;
  locationRevision: string;
}

export type UploadIntakeError =
  | { code: "owner_unavailable" | "idempotency_conflict" | "storage_failed" }
  | { code: "too_large"; limitBytes: number }
  /** The body's length differs from the size the request declared. */
  | { code: "size_mismatch" }
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
