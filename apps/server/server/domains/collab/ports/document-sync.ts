import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Result } from "../../../shared/result.js";

export type SchemaType = YjsTrackedSchemaType;

export type UpdateOrigin =
  | { type: "user"; userId: string }
  | { type: "agent"; actorTurnId: string }
  | { type: "import"; userId: string; source: string; filename: string; sourceId?: string }
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
