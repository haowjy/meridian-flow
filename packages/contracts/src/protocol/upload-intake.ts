import type { ContextEntryValidationReason } from "../context-entry-validation.js";
import type { CanonicalContextUri } from "../context-uri.js";
import type { Filetype } from "./filetype.js";

export type UploadOwner =
  | { kind: "chat"; projectId: string; chatId: string }
  | { kind: "source"; projectId: string };

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export const ASSETS_FOLDER = "assets";

export interface StartUploadInput {
  intakeId: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

export interface UploadSignedPut {
  url: string;
  headers: Record<string, string>;
}

export type UploadStart = { name: string } & (
  | { state: "reserved"; documentId: string; put: UploadSignedPut }
  | { state: "stored"; documentId: string }
  | { state: "finalized"; result: UploadIntakeResult }
);

export interface UploadIntakeResult {
  documentId: string;
  uri: CanonicalContextUri;
  fileType: Filetype;
}

export type UploadIntakeError =
  | { code: "owner_unavailable" | "idempotency_conflict" | "storage_failed" }
  | { code: "too_large"; limitBytes: number }
  | { code: "size_mismatch" }
  | { code: "not_uploaded" }
  | { code: "invalid_filename"; reason: ContextEntryValidationReason };

export type ChatUploadsResult = {
  uploads: readonly { documentId: string; attachedAt: string }[];
};
