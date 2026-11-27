import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import {
  classifyFiletype,
  type DocumentFileType,
  type Filetype,
} from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../../shared/uuid.js";
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
  ContextSubtree,
  LocatedContextDocument,
} from "../../ports/context-document-store.js";
import {
  createTreeReader,
  type PathResolution,
  type TreeView,
  type VisibleDocument,
  visibleDocuments,
  visibleFolders,
} from "../../tree/tree-view.js";

type DocumentRow = Pick<
  VisibleDocument,
  | "id"
  | "folderId"
  | "name"
  | "segment"
  | "extension"
  | "fileType"
  | "storageUrl"
  | "mimeType"
  | "sizeBytes"
  | "hasPreview"
  | "updatedAt"
  | "metadata"
  | "rank"
>;

function stemOf(row: Pick<DocumentRow, "name" | "extension">): string {
  return row.extension !== "" && row.name.toLowerCase().endsWith(`.${row.extension}`)
    ? row.name.slice(0, -(row.extension.length + 1))
    : row.name;
}

function binaryKind(fileType: string | null): DocumentFileType {
  const classified = classifyFiletype(fileType);
  return classified.kind === "binary" ? classified.fileType : "binary";
}

export function mapDocument(row: DocumentRow): ContextDocument {
  const { kind } = classifyFiletype(row.fileType);
  const isBinary = kind === "binary" || kind === "custom";
  return {
    id: row.id,
    folderId: row.folderId,
    name: stemOf(row),
    extension: row.extension,
    segment: row.segment,
    fileType: isBinary ? binaryKind(row.fileType) : null,
    filetype: isBinary ? null : (row.fileType as Filetype),
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    hasPreview: row.hasPreview,
    updatedAt: row.updatedAt.toISOString(),
    metadata: row.metadata,
    rank: row.rank,
  };
}

export async function locateDocumentById(
  db: Database,
  view: TreeView,
  documentId: string,
): Promise<LocatedContextDocument | null> {
  const found = await createTreeReader(db).findById(view, documentId as DocumentId);
  if (found.kind !== "found") return null;
  return {
    contextSourceId: found.document.contextSourceId,
    document: mapDocument(found.document),
    path: found.document.path,
  };
}

export interface DrizzleContextDocumentStoreDeps {
  db: Database;
  contextSourceId: string;
}

export class DrizzleContextDocumentStore implements ContextDocumentStore {
  constructor(private readonly deps: DrizzleContextDocumentStoreDeps) {}

  private get db() {
    return currentDrizzleDb(this.deps.db) as Database;
  }

  private get sourceId() {
    return this.deps.contextSourceId as ContextSourceId;
  }

  async contextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async existingContextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return runInDrizzleTransaction(this.db, operation);
  }

  async resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>> {
    const found = await createTreeReader(this.deps.db).resolveDocumentAddress(view, {
      contextSourceId: this.sourceId,
      path,
    });
    return found.kind === "found" && found.node.kind === "document"
      ? { kind: "found", node: mapDocument(found.node.document) }
      : { kind: "not_found" };
  }

  async resolveFolderAt(
    view: TreeView,
    path: string,
  ): Promise<PathResolution<ContextFolder | null>> {
    if (path.split("/").every((segment) => segment === "")) return { kind: "found", node: null };
    const found = await createTreeReader(this.deps.db).resolvePath(view, {
      contextSourceId: this.sourceId,
      path,
    });
    if (found.kind !== "found") return found;
    return found.node.kind === "folder"
      ? { kind: "found", node: found.node.folder }
      : { kind: "not_found" };
  }

  async findDocumentById(view: TreeView, documentId: string) {
    return locateDocumentById(this.deps.db, view, documentId);
  }

  async readSubtree(id: string): Promise<ContextSubtree | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.execute<{
      id: string;
      kind: "folder" | "document";
      parent_id: string | null;
      name: string;
      segment: string;
      extension: string;
      file_type: string;
      rank: string;
      storage_url: string | null;
      mime_type: string | null;
      size_bytes: string | null;
      has_preview: boolean | null;
      metadata: JsonObject | null;
      updated_at: string | Date | null;
    }>(sql`
      WITH RECURSIVE sub AS (
        SELECT t.id, t.kind, t.parent_id, t.name, t.segment, t.extension, t.file_type, t.rank, t.trash_record
        FROM tree_nodes t WHERE t.id = ${id}::uuid AND t.context_source_id = ${this.sourceId}::uuid
        UNION ALL
        SELECT c.id, c.kind, c.parent_id, c.name, c.segment, c.extension, c.file_type, c.rank, c.trash_record
        FROM tree_nodes c JOIN sub s ON c.parent_id = s.id
        WHERE c.context_source_id = ${this.sourceId}::uuid
          AND c.trash_record IS NOT DISTINCT FROM s.trash_record
      )
      SELECT sub.id::text AS id, sub.kind, sub.parent_id::text AS parent_id, sub.name, sub.segment, sub.extension,
        sub.file_type, sub.rank, d.storage_url, d.mime_type, d.size_bytes::text AS size_bytes,
        d.has_preview, d.metadata, d.updated_at
      FROM sub LEFT JOIN documents d ON d.id = sub.id`);
    const folders: ContextFolder[] = [];
    const documents: ContextDocument[] = [];
    for (const row of rows) {
      if (row.kind === "folder") {
        folders.push({
          id: row.id,
          parentId: row.parent_id,
          name: row.name,
          segment: row.segment,
          rank: row.rank,
        });
        continue;
      }
      documents.push(
        mapDocument({
          id: row.id as DocumentId,
          folderId: row.parent_id as FolderId | null,
          name: row.name,
          segment: row.segment,
          extension: row.extension,
          fileType: row.file_type,
          storageUrl: row.storage_url,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
          hasPreview: row.has_preview ?? false,
          updatedAt: new Date(row.updated_at ?? 0),
          metadata: row.metadata ?? {},
          rank: row.rank,
        }),
      );
    }
    const folder = folders.find((candidate) => candidate.id === id);
    const document = documents.find((candidate) => candidate.id === id);
    if (folder)
      return {
        root: { kind: "folder", folder },
        folders: folders.filter((candidate) => candidate.id !== id),
        documents,
      };
    return document ? { root: { kind: "document", document }, folders: [], documents: [] } : null;
  }

  async listTree(
    view: TreeView,
  ): Promise<{ folders: ContextFolder[]; documents: ContextDocument[] }> {
    const vf = visibleFolders(view);
    const vd = visibleDocuments(view);
    const [folders, docs] = await Promise.all([
      this.db
        .select({
          id: vf.id,
          parentId: vf.parentId,
          name: vf.name,
          segment: vf.segment,
          rank: vf.rank,
        })
        .from(vf)
        .where(eq(vf.contextSourceId, this.sourceId)),
      this.db.select().from(vd).where(eq(vd.contextSourceId, this.sourceId)),
    ]);
    return { folders, documents: docs.map(mapDocument) };
  }

  async listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]> {
    const vf = visibleFolders(view);
    return this.db
      .select({
        id: vf.id,
        parentId: vf.parentId,
        name: vf.name,
        segment: vf.segment,
        rank: vf.rank,
      })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, this.sourceId),
          parentId === null ? isNull(vf.parentId) : eq(vf.parentId, parentId as FolderId),
        ),
      );
  }

  async listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]> {
    const vd = visibleDocuments(view);
    const rows = await this.db
      .select()
      .from(vd)
      .where(
        and(
          eq(vd.contextSourceId, this.sourceId),
          folderId === null ? isNull(vd.folderId) : eq(vd.folderId, folderId as FolderId),
        ),
      );
    return rows.map(mapDocument);
  }
}
