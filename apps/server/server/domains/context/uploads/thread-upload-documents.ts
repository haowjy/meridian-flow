import type {
  DocumentFileType,
  Filetype,
  ThreadDocumentKind,
  ThreadDocumentRelationship,
  ThreadRecentDocumentItem,
  ThreadUploadDocumentItem,
} from "@meridian/contracts/protocol";
import { schemaTypeForFiletype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import type { ThreadDocumentRepository, TurnDocumentTouch } from "../../threads/index.js";
import { createInMemoryInternalUploadDocumentStore } from "../adapters/thread-uploads/in-memory-internal-upload-document-store.js";
import { createDrizzleInternalUploadDocumentStore } from "../adapters/thread-uploads/internal-upload-document-store.js";
import type {
  InternalUploadDocumentRecord,
  InternalUploadDocumentStore,
} from "../ports/internal-upload-document-store.js";

export interface UploadDocumentCreateInput {
  id: string;
  workbenchId: string;
  threadId: string;
  filename: string;
  name: string;
  extension: string;
  filetype: Filetype | null;
  mimeType: string;
  sizeBytes: number;
  markdownProjection: string;
  storageUrl: string | null;
}

export type UploadDocumentRecord = InternalUploadDocumentRecord;

export interface ThreadUploadDocumentStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  createUploadDocument(input: UploadDocumentCreateInput): Promise<UploadDocumentRecord>;
  updateMarkdownProjection(documentId: string, markdown: string): Promise<void>;
  getDocument(documentId: string): Promise<UploadDocumentRecord | null>;
  getUpload(threadId: string, documentId: string): Promise<ThreadUploadDocumentItem | null>;
  listUploads(threadId: string): Promise<ThreadUploadDocumentItem[]>;
  listRecent(touches: TurnDocumentTouch[]): Promise<ThreadRecentDocumentItem[]>;
}

export function uploadDocumentKind(fileType: DocumentFileType | null): ThreadDocumentKind {
  return fileType === null ? "tracked" : "binary";
}

export function markdownForTrackedUpload(_extension: string, content: string): string {
  return content;
}

function toUploadItem(row: {
  document: UploadDocumentRecord;
  threadId: string;
  relationship: string;
  firstTouchedAt: string;
  lastTouchedAt: string;
}): ThreadUploadDocumentItem {
  const filetype = row.document.filetype as Filetype | null;
  const fileType = row.document.fileType;
  return {
    threadId: row.threadId,
    documentId: row.document.id,
    relationship: row.relationship as ThreadDocumentRelationship,
    name: row.document.name,
    extension: row.document.extension,
    sizeBytes: row.document.sizeBytes,
    editable: fileType === null,
    filetype,
    schemaType: filetype ? schemaTypeForFiletype(filetype) : null,
    fileType,
    mimeType: row.document.mimeType,
    kind: uploadDocumentKind(fileType),
    firstTouchedAt: row.firstTouchedAt,
    lastTouchedAt: row.lastTouchedAt,
    updatedAt: row.document.updatedAt,
  };
}

function toRecentItem(
  touch: TurnDocumentTouch,
  document: UploadDocumentRecord,
): ThreadRecentDocumentItem {
  const filetype = document.filetype as Filetype | null;
  const fileType = document.fileType;
  return {
    threadId: touch.threadId,
    documentId: document.id,
    name: document.name,
    extension: document.extension,
    sizeBytes: document.sizeBytes,
    editable: fileType === null,
    filetype,
    schemaType: filetype ? schemaTypeForFiletype(filetype) : null,
    fileType,
    mimeType: document.mimeType,
    kind: uploadDocumentKind(fileType),
    touchedAt: touch.touchedAt,
    updatedAt: document.updatedAt,
  };
}

function createThreadUploadDocumentStore(
  documents: InternalUploadDocumentStore,
  threadDocuments?: ThreadDocumentRepository,
): ThreadUploadDocumentStore {
  const threadByDocumentId = new Map<string, string>();
  return {
    transaction(operation) {
      return documents.transaction(operation);
    },
    async createUploadDocument(input) {
      const row = await documents.createThreadUploadDocument(input);
      threadByDocumentId.set(row.id, input.threadId);
      return row;
    },
    async updateMarkdownProjection(documentId, markdown) {
      await documents.updateMarkdownProjection(documentId, markdown);
    },
    async getDocument(documentId) {
      return documents.findUploadDocument(documentId);
    },
    async getUpload(threadId, documentId) {
      const document = await documents.findUploadDocument(documentId);
      if (!document) return null;
      const attached = threadDocuments
        ? (await threadDocuments.listByThread(threadId)).find(
            (row) => row.documentId === documentId,
          )
        : null;
      if (threadDocuments && !attached) return null;
      if (!threadDocuments && threadByDocumentId.get(documentId) !== threadId) return null;
      return toUploadItem({
        document,
        threadId,
        relationship: attached?.relationship ?? "editing",
        firstTouchedAt: attached?.firstTouchedAt ?? document.updatedAt,
        lastTouchedAt: attached?.lastTouchedAt ?? document.updatedAt,
      });
    },
    async listUploads(threadId) {
      if (threadDocuments) {
        const attached = await threadDocuments.listByThread(threadId);
        const rows = await documents.findUploadDocuments(attached.map((row) => row.documentId));
        const byId = new Map(rows.map((row) => [row.id, row]));
        return attached.flatMap((row) => {
          const document = byId.get(row.documentId);
          return document
            ? [
                toUploadItem({
                  document,
                  threadId,
                  relationship: row.relationship,
                  firstTouchedAt: row.firstTouchedAt,
                  lastTouchedAt: row.lastTouchedAt,
                }),
              ]
            : [];
        });
      }
      const rows = await documents.findUploadDocuments([...threadByDocumentId.keys()]);
      return rows
        .filter((document) => threadByDocumentId.get(document.id) === threadId)
        .map((document) =>
          toUploadItem({
            document,
            threadId,
            relationship: "editing",
            firstTouchedAt: document.updatedAt,
            lastTouchedAt: document.updatedAt,
          }),
        )
        .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt));
    },
    async listRecent(touches) {
      const rows = await documents.findUploadDocuments(touches.map((touch) => touch.documentId));
      const byId = new Map(rows.map((row) => [row.id, row]));
      return touches.flatMap((touch) => {
        const document = byId.get(touch.documentId);
        return document ? [toRecentItem(touch, document)] : [];
      });
    },
  };
}

export function createDrizzleThreadUploadDocumentStore(
  db: Database,
  threadDocuments?: ThreadDocumentRepository,
): ThreadUploadDocumentStore {
  return createThreadUploadDocumentStore(
    createDrizzleInternalUploadDocumentStore(db),
    threadDocuments,
  );
}

export function createInMemoryThreadUploadDocumentStore(
  threadDocuments?: ThreadDocumentRepository,
): ThreadUploadDocumentStore {
  return createThreadUploadDocumentStore(
    createInMemoryInternalUploadDocumentStore(),
    threadDocuments,
  );
}
