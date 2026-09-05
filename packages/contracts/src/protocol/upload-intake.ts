/** JSON contracts for authoritative project upload intake. */
import type { CanonicalContextUri } from "../context-uri.js";
import type { Filetype } from "./filetype.js";

export type UploadOwner =
  | { kind: "work"; projectId: string; workId: string }
  | { kind: "none"; projectId: string };

export interface UploadIntakeResult {
  documentId: string;
  uri: CanonicalContextUri;
  fileType: Filetype;
  locationRevision: string;
}

export type UploadIntakeErrorCode = "owner_unavailable" | "idempotency_conflict" | "storage_failed";

export interface UploadIntakeError {
  code: UploadIntakeErrorCode;
}

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
