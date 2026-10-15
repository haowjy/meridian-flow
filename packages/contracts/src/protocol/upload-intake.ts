/** JSON contracts for authoritative project upload intake. */
import type { ContextEntryValidationReason } from "../context-entry-validation.js";
import type { CanonicalContextUri } from "../context-uri.js";
import type { Filetype } from "./filetype.js";

/**
 * The chat (a primary thread) a file was attached to; its row may not exist yet.
 * TODO(#875 P3): delete the `work` variant with the Work-owned intake path.
 */
export type UploadOwner =
  | { kind: "chat"; projectId: string; chatId: string }
  | { kind: "work"; projectId: string; workId: string };

export interface UploadIntakeResult {
  documentId: string;
  uri: CanonicalContextUri;
  fileType: Filetype;
  locationRevision: string;
}

export type UploadIntakeError =
  | { code: "owner_unavailable" | "idempotency_conflict" | "storage_failed" }
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
