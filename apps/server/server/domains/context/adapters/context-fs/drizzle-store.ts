/** Drizzle ContextDocumentStore for one Meridian context source. */
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { and, eq, ilike, isNull } from "drizzle-orm";
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
  ContextSearchRow,
  CreateBinaryDocumentInput,
  UpsertDocumentInput,
} from "../../ports/context-document-store.js";
import { firstLineMatch } from "./match.js";

type FolderRow = typeof folders.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;

const BINARY_FILE_TYPES = new Set<DocumentFileType>(["docx", "image", "pdf", "binary"]);

function mapFolder(row: FolderRow): ContextFolder {
  return { id: row.id, parentId: row.parentId, name: row.name };
}

function mapDocument(row: DocumentRow): ContextDocument {
  const storedType = row.fileType as Filetype | DocumentFileType;
  const isBinary = BINARY_FILE_TYPES.has(storedType as DocumentFileType) || row.storageUrl !== null;
  return {
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    extension: row.extension,
    markdown: row.markdownProjection,
    fileType: isBinary ? (storedType as DocumentFileType) : null,
    filetype: isBinary ? null : (storedType as Filetype),
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DrizzleContextDocumentStoreDeps {
  db: Database;
  contextSourceId: string;
}

export async function updateDocumentProjectionById(
  db: Database,
  documentId: string,
  markdown: string,
): Promise<boolean> {
  const [row] = await db
    .update(documents)
    .set({
      markdownProjection: markdown,
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .returning({ id: documents.id });
  return Boolean(row);
}

export class DrizzleContextDocumentStore implements ContextDocumentStore {
  constructor(private readonly deps: DrizzleContextDocumentStoreDeps) {}

  private get db() {
    return this.deps.db;
  }

  private get sourceId() {
    return this.deps.contextSourceId;
  }

  async findFolder(parentId: string | null, name: string): Promise<ContextFolder | null> {
    const [row] = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, this.sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          eq(folders.name, name),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    return row ? mapFolder(row) : null;
  }

  async createFolder(parentId: string | null, name: string): Promise<ContextFolder> {
    const [row] = await this.db
      .insert(folders)
      .values({ contextSourceId: this.sourceId, parentId, name })
      .returning();
    if (!row) throw new Error("Failed to create folder");
    return mapFolder(row);
  }

  async findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          eq(documents.name, name),
          eq(documents.extension, extension),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    return row ? mapDocument(row) : null;
  }

  async upsertDocument(input: UpsertDocumentInput): Promise<ContextDocument> {
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    const values = {
      fileType: input.filetype,
      storageUrl: null,
      mimeType: null,
      markdownProjection: input.markdown,
      sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
      updatedAt: new Date(),
    };
    if (existing) {
      const [row] = await this.db
        .update(documents)
        .set(values)
        .where(eq(documents.id, existing.id))
        .returning();
      if (!row) throw new Error(`Failed to update document: ${existing.id}`);
      return mapDocument(row);
    }
    const [row] = await this.db
      .insert(documents)
      .values({
        contextSourceId: this.sourceId,
        folderId: input.folderId,
        name: input.name,
        extension: input.extension,
        fileType: input.filetype,
        markdownProjection: input.markdown,
        sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
      })
      .returning();
    if (!row) throw new Error("Failed to insert document");
    return mapDocument(row);
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    const [row] = await this.db
      .insert(documents)
      .values({
        contextSourceId: this.sourceId,
        folderId: input.folderId,
        name: input.name,
        extension: input.extension,
        fileType: input.fileType,
        storageUrl: input.storageUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        markdownProjection: "",
      })
      .returning();
    if (!row) throw new Error("Failed to create binary document");
    return mapDocument(row);
  }

  async listFolders(parentId: string | null): Promise<ContextFolder[]> {
    const rows = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, this.sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          isNull(folders.deletedAt),
        ),
      );
    return rows.map(mapFolder);
  }

  async listDocuments(folderId: string | null): Promise<ContextDocument[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          isNull(documents.deletedAt),
        ),
      );
    return rows.map(mapDocument);
  }

  private async folderPath(folderId: string | null): Promise<string> {
    const names: string[] = [];
    let current = folderId;
    while (current !== null) {
      const [row]: FolderRow[] = await this.db
        .select()
        .from(folders)
        .where(eq(folders.id, current))
        .limit(1);
      if (!row) break;
      names.unshift(row.name);
      current = row.parentId;
    }
    return names.join("/");
  }

  async searchDocuments(query: string): Promise<ContextSearchRow[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          isNull(documents.deletedAt),
          ilike(documents.markdownProjection, `%${query}%`),
        ),
      );
    const out: ContextSearchRow[] = [];
    for (const row of rows) {
      const match = firstLineMatch(row.markdownProjection, query);
      if (!match) continue;
      out.push({
        document: mapDocument(row),
        folderPath: await this.folderPath(row.folderId),
        excerpt: match.excerpt,
        line: match.line,
      });
    }
    return out;
  }
}
