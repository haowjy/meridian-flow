/**
 * Collab facade — stubbed during agent-edit extraction (Step 1).
 * TODO(agent-edit): replace with @meridian/agent-edit composition root.
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type * as Y from "yjs";
import type { DocumentAccessPort } from "../../lib/document-access.js";
import type { Result } from "../../shared/result.js";
import type { EventSink } from "../observability/index.js";
import type { createDrizzleDocumentStore } from "./adapters/drizzle/document-store.js";

const STUB_MESSAGE = "Old collab code deleted — waiting for agent-edit package";

function collabStub(): never {
  throw new Error(STUB_MESSAGE);
}

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

export type DocumentWriteOrigin =
  | { type: "agent"; actorTurnId: TurnId }
  | { type: "user"; actorUserId: UserId };

export type DocumentWriteResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Buffer;
  originType: DocumentWriteOrigin["type"];
  actorTurnId: TurnId | null;
  actorUserId: UserId | null;
};

export type CollabPersistenceMetrics = {
  queues: Array<{
    documentId: string;
    depth: number;
    oldestAgeMs: number;
    dropped: number;
  }>;
  liveDocumentCount: number;
  openConnectionCount: number;
};

export type HocuspocusDocumentSync = {
  bindHocuspocus(instance: Hocuspocus): void;
  loadHocuspocusDocument(documentId: DocumentId): Promise<Uint8Array | undefined>;
  persistConnectionUpdate(input: {
    documentId: DocumentId;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
  }): void;
  storeHocuspocusDocument(documentId: DocumentId, document: Y.Doc): Promise<void>;
  drainHocuspocusPersistence(): Promise<void>;
  getPersistenceQueueMetrics(): CollabPersistenceMetrics;
};

export type DocumentSyncFacade = DocumentSyncPort &
  HocuspocusDocumentSync & {
    writeDocument(input: {
      documentId: DocumentId;
      markdown: string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }): Promise<DocumentWriteResult>;
    editDocument(input: {
      documentId: DocumentId;
      transform: (markdown: string) => string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }): Promise<DocumentWriteResult & { beforeMarkdown: string }>;
    getLastUpdateAttribution(documentId: DocumentId): Promise<{
      originType: string | null;
      actorTurnId: TurnId | null;
      actorUserId: UserId | null;
      updateSeq: number | null;
    }>;
  };

export type DocumentSyncService = DocumentSyncFacade;

export type DocumentStore = ReturnType<typeof createDrizzleDocumentStore>;

export interface DocumentSyncServiceOptions {
  autoCheckpointEvery?: number;
  compaction?: false;
}

function stubDocumentSyncPort(): DocumentSyncFacade {
  const stub = () => collabStub();
  return {
    getOrCreateMirror: stub,
    forgetMirror: stub,
    readAsMarkdown: stub,
    editFromMarkdown: stub,
    writeFromMarkdown: stub,
    checkpoint: stub,
    restore: stub,
    listCheckpoints: stub,
    writeDocument: stub,
    editDocument: stub,
    bindHocuspocus: stub,
    loadHocuspocusDocument: stub,
    persistConnectionUpdate: stub,
    storeHocuspocusDocument: stub,
    drainHocuspocusPersistence: stub,
    getPersistenceQueueMetrics: stub,
    getLastUpdateAttribution: stub,
  };
}

export function createStubDocumentSyncFacade(): DocumentSyncFacade {
  // TODO(agent-edit): replace with @meridian/agent-edit in-memory adapter
  return stubDocumentSyncPort();
}

export function createDocumentSyncService(_deps: {
  db: Database;
  documentAccess: DocumentAccessPort & {
    requireOwnedDocument(documentId: DocumentId, userId: UserId): Promise<void>;
  };
  eventSink?: EventSink;
  options?: DocumentSyncServiceOptions;
}): DocumentSyncFacade {
  // TODO(agent-edit): replace with @meridian/agent-edit
  return stubDocumentSyncPort();
}
