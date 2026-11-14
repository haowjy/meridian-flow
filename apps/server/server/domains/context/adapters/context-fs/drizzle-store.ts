/**
 * Drizzle ContextDocumentStore for one Meridian context source: reads through one tree view
 * (live, or one Work's). Nothing here writes the tree; the list does (`tree-writes.ts`).
 */

import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
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
import { isStorageBackedDocument } from "../context-file-entry.js";

type DocumentRow = Pick<
  VisibleDocument,
  | "id"
  | "folderId"
  | "name"
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

/** A node's name is its full filename; the document shape keeps the stem apart from the extension. */
function stemOf(row: Pick<DocumentRow, "name" | "extension">): string {
  return row.extension !== "" && row.name.toLowerCase().endsWith(`.${row.extension}`)
    ? row.name.slice(0, -(row.extension.length + 1))
    : row.name;
}

export function mapDocument(row: DocumentRow): ContextDocument {
  const isBinary = isStorageBackedDocument(row);
  return {
    id: row.id,
    folderId: row.folderId,
    name: stemOf(row),
    extension: row.extension,
    fileType: isBinary ? (row.fileType as DocumentFileType) : null,
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

/** A document visible in `view`, by id. The row may live in another source. */
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
    if (found.kind === "ambiguous") return found;
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
          rank: vf.rank,
        })
        .from(vf)
        .where(eq(vf.contextSourceId, this.sourceId)),
      this.db.select().from(vd).where(eq(vd.contextSourceId, this.sourceId)),
    ]);
    return { folders, documents: docs.map(mapDocument) };
  }

  async namesAt(view: TreeView, parentId: string | null): Promise<Set<string>> {
    const vd = visibleDocuments(view);
    const vf = visibleFolders(view);
    const here = (parent: typeof vd.folderId | typeof vf.parentId) =>
      parentId === null ? isNull(parent) : eq(parent, parentId as FolderId);
    const [documents, folders] = await Promise.all([
      this.db
        .select({ name: vd.name })
        .from(vd)
        .where(and(eq(vd.contextSourceId, this.sourceId), here(vd.folderId))),
      this.db
        .select({ name: vf.name })
        .from(vf)
        .where(and(eq(vf.contextSourceId, this.sourceId), here(vf.parentId))),
    ]);
    return new Set([...documents, ...folders].map((row) => row.name));
  }

  async listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]> {
    const vf = visibleFolders(view);
    return this.db
      .select({ id: vf.id, parentId: vf.parentId, name: vf.name, rank: vf.rank })
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
