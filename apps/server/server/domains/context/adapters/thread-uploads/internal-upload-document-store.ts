// @ts-nocheck
import {
  type DocumentFileType,
  documentFileTypeFor,
  type Filetype,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import type {
  InternalUploadDocumentCreateInput,
  InternalUploadDocumentRecord,
  InternalUploadDocumentStore,
} from "../../ports/internal-upload-document-store.js";

const THREAD_UPLOAD_SOURCE_SLUG = "thread_uploads";
const THREAD_UPLOAD_SOURCE_NAME = "Thread Uploads";
const BINARY_FILE_TYPES = new Set<DocumentFileType>(["docx", "image", "pdf", "binary"]);

type DocumentRow = typeof documents.$inferSelect;

function mapDocument(row: DocumentRow): InternalUploadDocumentRecord {
  const storedType = row.fileType as Filetype | DocumentFileType;
  const binary = BINARY_FILE_TYPES.has(storedType as DocumentFileType) || row.storageUrl !== null;
  return {
    id: row.id,
    name: row.name,
    extension: row.extension,
    filetype: binary ? null : (storedType as Filetype),
    fileType: binary ? (storedType as DocumentFileType) : null,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    storageUrl: row.storageUrl,
    markdownProjection: row.markdownProjection,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findUploadContextSource(db: Database, projectId: string): Promise<string | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.projectId, projectId),
        eq(contextSources.slug, THREAD_UPLOAD_SOURCE_SLUG),
        isNull(contextSources.workId),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function ensureUploadContextSource(db: Database, projectId: string): Promise<string> {
  const existing = await findUploadContextSource(db, projectId);
  if (existing) return existing;

  const [created] = await currentDrizzleDb(db)
    .insert(contextSources)
    .values({
      projectId: projectId,
      name: THREAD_UPLOAD_SOURCE_NAME,
      slug: THREAD_UPLOAD_SOURCE_SLUG,
      scope: "project",
      adapterType: "local",
      adapterConfig: { internal: true, kind: "thread_uploads" },
    })
    .onConflictDoNothing({
      target: [contextSources.projectId, contextSources.slug],
      where: sql`${contextSources.workId} IS NULL AND ${contextSources.deletedAt} IS NULL`,
    })
    .returning({ id: contextSources.id });
  if (created) return created.id;

  const raced = await findUploadContextSource(db, projectId);
  if (!raced) throw new Error(`Failed to provision thread upload source for ${projectId}`);
  return raced;
}

export function createDrizzleInternalUploadDocumentStore(
  db: Database,
): InternalUploadDocumentStore {
  return {
    transaction(operation) {
      return runInDrizzleTransaction(db, operation);
    },
    async createThreadUploadDocument(input: InternalUploadDocumentCreateInput) {
      const contextSourceId = await ensureUploadContextSource(db, input.projectId);
      const fileType = documentFileTypeFor(input);
      const storedFileType = fileType ?? input.filetype ?? "text";
      const [row] = await currentDrizzleDb(db)
        .insert(documents)
        .values({
          id: input.id,
          contextSourceId,
          folderId: null,
          name: `${input.threadId}-${input.name}`,
          extension: input.extension,
          fileType: storedFileType,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          markdownProjection: input.markdownProjection,
          storageUrl: input.storageUrl,
          metadata: {
            source: "thread_upload",
            threadId: input.threadId,
            filename: input.filename,
            displayName: input.name,
          },
        })
        .returning();
      if (!row) throw new Error("Failed to create upload document");
      return mapDocument(row);
    },
    async updateMarkdownProjection(documentId, markdown) {
      await currentDrizzleDb(db)
        .update(documents)
        .set({
          markdownProjection: markdown,
          sizeBytes: Buffer.byteLength(markdown, "utf8"),
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
    },
    async findUploadDocument(documentId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
        .limit(1);
      return row ? mapDocument(row) : null;
    },
    async findUploadDocuments(documentIds) {
      if (documentIds.length === 0) return [];
      const rows = await currentDrizzleDb(db)
        .select()
        .from(documents)
        .where(and(inArray(documents.id, documentIds), isNull(documents.deletedAt)));
      return rows.map(mapDocument);
    },
  };
}
