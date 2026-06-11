import type * as Y from "yjs";
import type { Result } from "../../../shared/result.js";

export type SchemaType = "document" | "code";

export type UpdateOrigin =
  | { type: "user"; userId: string }
  | { type: "agent"; actorTurnId: string }
  | { type: "system" };

export type SyncError =
  | { code: "not_found"; documentId: string }
  | { code: "checkpoint_not_found"; checkpointId: string }
  | { code: "corrupt_state"; documentId: string; message: string }
  | { code: "edit_not_found"; oldText: string }
  | { code: "ambiguous_edit"; oldText: string; matchCount: number };

export interface CheckpointInfo {
  id: string;
  reason: string;
  createdAt: string;
}

export type PersistedUpdate = {
  updateSeq: number;
  updateData: Uint8Array;
};

export interface DocumentSyncPort {
  getOrCreateMirror(
    documentId: string,
    initialContent: string,
    filetype: string,
  ): Promise<Result<string, SyncError>>;
  forgetMirror?(documentId: string): void;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  editFromMarkdown(
    documentId: string,
    oldText: string,
    newText: string,
    origin: UpdateOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeFromMarkdown(
    documentId: string,
    markdown: string,
    origin: UpdateOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  checkpoint(documentId: string, reason: string): Promise<Result<string, SyncError>>;
  restore(documentId: string, checkpointId: string): Promise<Result<void, SyncError>>;
  listCheckpoints(documentId: string): Promise<Result<CheckpointInfo[], SyncError>>;
}

export interface DocumentSyncTransport {
  getDoc(documentId: string): Promise<Result<Y.Doc, SyncError>>;
  applyUpdate(
    documentId: string,
    update: Uint8Array,
    origin: UpdateOrigin,
  ): Promise<Result<void, SyncError>>;
  encodeState(documentId: string): Promise<Result<Uint8Array, SyncError>>;
}
