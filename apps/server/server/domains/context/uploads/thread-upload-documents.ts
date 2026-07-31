/** Thread attachment rail projections over canonical context documents. */

import type {
  DocumentFileType,
  Filetype,
  ThreadDocumentKind,
  ThreadDocumentRelationship,
  ThreadRecentDocumentItem,
  ThreadUploadDocumentItem,
} from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  folders,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ThreadDocumentRepository, TurnDocumentTouch } from "../../threads/index.js";
import { renderFilename } from "../context/paths.js";
import { toCanonical } from "../context/uri.js";

const BINARY_FILE_TYPES = new Set<DocumentFileType>(["docx", "image", "pdf", "binary"]);

export interface UploadDocumentRecord {
  id: string;
  name: string;
  extension: string;
  filetype: Filetype | null;
  fileType: DocumentFileType | null;
  mimeType: string | null;
  sizeBytes: number | null;
  storageUrl: string | null;
  markdownProjection: string;
  updatedAt: string;
  /** Canonical URI when the document belongs to the work-scoped uploads source. */
  uploadUri: string | null;
}

export interface ThreadUploadDocumentStore {
  getDocument(documentId: string): Promise<UploadDocumentRecord | null>;
  getUpload(threadId: string, documentId: string): Promise<ThreadUploadDocumentItem | null>;
  listUploads(threadId: string): Promise<ThreadUploadDocumentItem[]>;
  listRecent(touches: TurnDocumentTouch[]): Promise<ThreadRecentDocumentItem[]>;
}

export function uploadDocumentKind(fileType: DocumentFileType | null): ThreadDocumentKind {
  return fileType === null ? "tracked" : "binary";
}

function toUploadItem(row: {
  document: UploadDocumentRecord;
  threadId: string;
  relationship: string;
  firstTouchedAt: string;
  lastTouchedAt: string;
}): ThreadUploadDocumentItem {
  const classification = classifyFiletype(row.document.filetype);
  return {
    threadId: row.threadId,
    documentId: row.document.id,
    relationship: row.relationship as ThreadDocumentRelationship,
    name: row.document.name,
    extension: row.document.extension,
    sizeBytes: row.document.sizeBytes,
    editable: row.document.fileType === null,
    filetype: row.document.filetype,
    schemaType: classification.kind === "tracked" ? classification.schemaType : null,
    fileType: row.document.fileType,
    mimeType: row.document.mimeType,
    kind: uploadDocumentKind(row.document.fileType),
    firstTouchedAt: row.firstTouchedAt,
    lastTouchedAt: row.lastTouchedAt,
    updatedAt: row.document.updatedAt,
  };
}

function toRecentItem(
  touch: TurnDocumentTouch,
  document: UploadDocumentRecord,
): ThreadRecentDocumentItem {
  const classification = classifyFiletype(document.filetype);
  return {
    threadId: touch.threadId,
    documentId: document.id,
    name: document.name,
    extension: document.extension,
    sizeBytes: document.sizeBytes,
    editable: document.fileType === null,
    filetype: document.filetype,
    schemaType: classification.kind === "tracked" ? classification.schemaType : null,
    fileType: document.fileType,
    mimeType: document.mimeType,
    kind: uploadDocumentKind(document.fileType),
    touchedAt: touch.touchedAt,
    updatedAt: document.updatedAt,
  };
}

export function createDrizzleThreadUploadDocumentStore(
  database: Database,
  threadDocuments: ThreadDocumentRepository,
): ThreadUploadDocumentStore {
  async function pathForDocument(input: {
    contextSourceId: string;
    folderId: string | null;
    name: string;
    extension: string;
  }): Promise<string | null> {
    const segments = [renderFilename(input.name, input.extension)];
    const visited = new Set<string>();
    let folderId = input.folderId;
    while (folderId) {
      if (visited.has(folderId)) return null;
      visited.add(folderId);
      const [folder] = await currentDrizzleDb(database)
        .select({
          id: folders.id,
          contextSourceId: folders.contextSourceId,
          parentId: folders.parentId,
          name: folders.name,
        })
        .from(folders)
        .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)))
        .limit(1);
      if (!folder || folder.contextSourceId !== input.contextSourceId) return null;
      segments.unshift(folder.name);
      folderId = folder.parentId;
    }
    return segments.join("/");
  }

  async function findDocuments(documentIds: string[]): Promise<UploadDocumentRecord[]> {
    if (documentIds.length === 0) return [];
    const rows = await currentDrizzleDb(database)
      .select({
        document: documents,
        sourceSlug: contextSources.slug,
        sourceWorkId: contextSources.workId,
      })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .where(
        and(
          inArray(documents.id, documentIds),
          contentDocumentPredicate(),
          isNull(documents.deletedAt),
          isNull(contextSources.deletedAt),
        ),
      );

    return Promise.all(
      rows.map(async ({ document, sourceSlug, sourceWorkId }) => {
        const storedType = document.fileType as Filetype | DocumentFileType;
        const binary =
          BINARY_FILE_TYPES.has(storedType as DocumentFileType) || document.storageUrl !== null;
        const path =
          sourceSlug === "uploads" && sourceWorkId
            ? await pathForDocument({
                contextSourceId: document.contextSourceId,
                folderId: document.folderId,
                name: document.name,
                extension: document.extension,
              })
            : null;
        return {
          id: document.id,
          name: document.name,
          extension: document.extension,
          filetype: binary ? null : (storedType as Filetype),
          fileType: binary ? (storedType as DocumentFileType) : null,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes === null ? null : Number(document.sizeBytes),
          storageUrl: document.storageUrl,
          markdownProjection: document.markdownProjection,
          updatedAt: document.updatedAt.toISOString(),
          uploadUri: path ? toCanonical("uploads", path, sourceWorkId) : null,
        };
      }),
    );
  }

  return {
    async getDocument(documentId) {
      return (await findDocuments([documentId]))[0] ?? null;
    },
    async getUpload(threadId, documentId) {
      const attached = (await threadDocuments.listByThread(threadId)).find(
        (row) => row.documentId === documentId,
      );
      if (!attached) return null;
      const document = (await findDocuments([documentId]))[0] ?? null;
      if (!document?.uploadUri) return null;
      return toUploadItem({
        document,
        threadId,
        relationship: attached.relationship,
        firstTouchedAt: attached.firstTouchedAt,
        lastTouchedAt: attached.lastTouchedAt,
      });
    },
    async listUploads(threadId) {
      const attached = await threadDocuments.listByThread(threadId);
      const rows = await findDocuments(attached.map((row) => row.documentId));
      const byId = new Map(
        rows
          .filter((document) => document.uploadUri !== null)
          .map((document) => [document.id, document]),
      );
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
    },
    async listRecent(touches) {
      const rows = await findDocuments(touches.map((touch) => touch.documentId));
      const byId = new Map(rows.map((row) => [row.id, row]));
      return touches.flatMap((touch) => {
        const document = byId.get(touch.documentId);
        return document ? [toRecentItem(touch, document)] : [];
      });
    },
  };
}
