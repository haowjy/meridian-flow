import {
  DOCUMENT_KINDS,
  type DocumentKind,
  isContentDocumentKind,
} from "@meridian/database/schema";
/**
 * In-memory ContextFS persistence for tests and lightweight composition: the
 * per-source ContextDocumentStore CRUD surface over a shared backing map that
 * mirrors Postgres, so moving across sources changes row ownership instead of
 * copying documents. The tree mutations live in in-memory-tree-mutation-store.ts.
 */

import { renderFilename } from "../../context/paths.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
  type ContextFolder,
  type CreateBinaryDocumentInput,
  type CreateDocumentInput,
  type UpsertBinaryDocumentInput,
} from "../../ports/context-document-store.js";

export type FolderRow = ContextFolder & {
  contextSourceId: string;
  deletedAt: string | null;
  updatedAt: string;
};
export type DocumentRow = ContextDocument & {
  contextSourceId: string;
  deletedAt: string | null;
  kind: DocumentKind;
};

export interface InMemoryContextDocumentStoreBacking {
  previousLocations: Map<string, string>;
  folders: Map<string, FolderRow>;
  documents: Map<string, DocumentRow>;
  clock: { value: number };
  availabilityGeneration: { value: bigint };
}

export interface InMemoryContextDocumentStoreOptions {
  sourceId?: string;
  backing?: InMemoryContextDocumentStoreBacking;
}

export function createInMemoryContextDocumentStoreBacking(): InMemoryContextDocumentStoreBacking {
  return {
    previousLocations: new Map(),
    folders: new Map(),
    documents: new Map(),
    clock: { value: 0 },
    availabilityGeneration: { value: 0n },
  };
}

export function findInMemoryContextDocumentsById(
  backing: InMemoryContextDocumentStoreBacking,
  documentIds: readonly string[],
): ContextDocument[] {
  return documentIds.flatMap((id) => {
    const row = backing.documents.get(id);
    if (!row || !isContentDocumentKind(row.kind) || row.deletedAt !== null) return [];
    const {
      contextSourceId: _contextSourceId,
      deletedAt: _deletedAt,
      kind: _kind,
      ...document
    } = row;
    return [{ ...document }];
  });
}

export function hasOppositeEntry(
  backing: InMemoryContextDocumentStoreBacking,
  sourceId: string,
  parentId: string | null,
  filename: string,
  kind: "file" | "folder",
): boolean {
  return kind === "file"
    ? [...backing.folders.values()].some(
        (row) =>
          row.contextSourceId === sourceId &&
          row.parentId === parentId &&
          row.name === filename &&
          row.deletedAt === null,
      )
    : [...backing.documents.values()].some(
        (row) =>
          row.contextSourceId === sourceId &&
          row.folderId === parentId &&
          renderFilename(row.name, row.extension) === filename &&
          isContentDocumentKind(row.kind) &&
          row.deletedAt === null,
      );
}

export function locationPath(
  backing: InMemoryContextDocumentStoreBacking,
  parentId: string | null,
  name: string,
): string {
  const segments = [name];
  while (parentId) {
    const folder = backing.folders.get(parentId);
    if (!folder || folder.deletedAt !== null) throw new Error("Namespace parent not found");
    segments.unshift(folder.name);
    parentId = folder.parentId;
  }
  return segments.join("/");
}

export function claimLocation(
  backing: InMemoryContextDocumentStoreBacking,
  sourceId: string,
  parentId: string | null,
  name: string,
): void {
  backing.previousLocations.delete(
    JSON.stringify([sourceId, locationPath(backing, parentId, name)]),
  );
}

/**
 * In-memory {@link ContextDocumentStore} for a single context source. A shared
 * backing lets tests create two source-scoped stores over one row graph; adoption
 * then mirrors SQL by changing `contextSourceId` instead of copying rows.
 */
export class InMemoryContextDocumentStore implements ContextDocumentStore {
  private readonly sourceId: string;
  private readonly backing: InMemoryContextDocumentStoreBacking;

  constructor(options: InMemoryContextDocumentStoreOptions = {}) {
    this.sourceId = options.sourceId ?? crypto.randomUUID();
    this.backing = options.backing ?? createInMemoryContextDocumentStoreBacking();
  }

  private nextTimestamp(): string {
    this.backing.clock.value += 1;
    return new Date(this.backing.clock.value * 1000).toISOString();
  }

  private publicFolder(folder: FolderRow): ContextFolder {
    return { id: folder.id, parentId: folder.parentId, name: folder.name };
  }

  private publicDocument(doc: DocumentRow): ContextDocument {
    const { contextSourceId: _contextSourceId, deletedAt: _deletedAt, kind: _kind, ...out } = doc;
    return { ...out };
  }

  async contextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async existingContextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async recordDocumentMembership(_documentId: string): Promise<void> {}

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const foldersSnapshot = new Map(
      [...this.backing.folders].map(([id, row]) => [id, { ...row }] as const),
    );
    const documentsSnapshot = new Map(
      [...this.backing.documents].map(([id, row]) => [id, { ...row }] as const),
    );
    const previousLocationsSnapshot = new Map(this.backing.previousLocations);
    const clockSnapshot = this.backing.clock.value;
    try {
      return await operation();
    } catch (error) {
      this.backing.folders.clear();
      for (const entry of foldersSnapshot) this.backing.folders.set(...entry);
      this.backing.documents.clear();
      for (const entry of documentsSnapshot) this.backing.documents.set(...entry);
      this.backing.previousLocations = previousLocationsSnapshot;
      this.backing.clock.value = clockSnapshot;
      throw error;
    }
  }

  async findFolder(parentId: string | null, name: string): Promise<ContextFolder | null> {
    for (const folder of this.backing.folders.values()) {
      if (
        folder.contextSourceId === this.sourceId &&
        folder.deletedAt === null &&
        folder.parentId === parentId &&
        folder.name === name
      ) {
        return this.publicFolder(folder);
      }
    }
    return null;
  }

  async createFolder(parentId: string | null, name: string): Promise<ContextFolder> {
    if (hasOppositeEntry(this.backing, this.sourceId, parentId, name, "folder"))
      throw new ContextEntryConflictError();
    const existing = await this.findFolder(parentId, name);
    if (existing) return existing;
    const folder: FolderRow = {
      id: crypto.randomUUID(),
      contextSourceId: this.sourceId,
      parentId,
      name,
      deletedAt: null,
      updatedAt: this.nextTimestamp(),
    };
    this.backing.folders.set(folder.id, folder);
    claimLocation(this.backing, folder.contextSourceId, folder.parentId, folder.name);
    return this.publicFolder(folder);
  }

  async findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null> {
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === this.sourceId &&
        isContentDocumentKind(doc.kind) &&
        doc.deletedAt === null &&
        doc.folderId === folderId &&
        doc.name === name &&
        doc.extension === extension
      ) {
        return this.publicDocument(doc);
      }
    }
    return null;
  }

  async createDocument(input: CreateDocumentInput): Promise<ContextDocument> {
    if (
      hasOppositeEntry(
        this.backing,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
        "file",
      )
    )
      throw new ContextEntryConflictError();
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    if (existing && existing.fileType !== null) {
      throw new Error(`Cannot replace binary document with tracked text: ${existing.id}`);
    }
    const sizeBytes = Buffer.byteLength(input.markdown, "utf8");
    if (existing) throw new ContextEntryConflictError();
    const doc: DocumentRow = {
      id: input.id ?? crypto.randomUUID(),
      contextSourceId: this.sourceId,
      kind: DOCUMENT_KINDS.content,
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
      markdown: input.markdown,
      fileType: null,
      filetype: input.filetype,
      storageUrl: null,
      mimeType: null,
      sizeBytes,
      updatedAt: this.nextTimestamp(),
      provisionalName: input.provisionalName ?? false,
      deletedAt: null,
    };
    this.backing.documents.set(doc.id, doc);
    claimLocation(
      this.backing,
      doc.contextSourceId,
      doc.folderId,
      doc.extension ? `${doc.name}.${doc.extension}` : doc.name,
    );
    return this.publicDocument(doc);
  }

  async createDocumentRecordIfAbsent(input: CreateDocumentInput): Promise<ContextDocument | null> {
    if (
      hasOppositeEntry(
        this.backing,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
        "file",
      )
    )
      return null;
    if (this.backing.documents.has(input.id ?? "")) return null;
    for (const row of this.backing.documents.values()) {
      if (
        row.contextSourceId === this.sourceId &&
        isContentDocumentKind(row.kind) &&
        row.deletedAt === null &&
        row.folderId === input.folderId &&
        row.name === input.name &&
        row.extension === input.extension
      ) {
        return null;
      }
    }
    const sizeBytes = Buffer.byteLength(input.markdown, "utf8");
    const doc: DocumentRow = {
      id: input.id ?? crypto.randomUUID(),
      contextSourceId: this.sourceId,
      kind: DOCUMENT_KINDS.content,
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
      markdown: input.markdown,
      fileType: null,
      filetype: input.filetype,
      storageUrl: null,
      mimeType: null,
      sizeBytes,
      updatedAt: this.nextTimestamp(),
      provisionalName: input.provisionalName ?? false,
      deletedAt: null,
    };
    this.backing.documents.set(doc.id, doc);
    claimLocation(
      this.backing,
      doc.contextSourceId,
      doc.folderId,
      doc.extension ? `${doc.name}.${doc.extension}` : doc.name,
    );
    return this.publicDocument(doc);
  }

  async findDocumentById(documentId: string) {
    const row = this.backing.documents.get(documentId);
    if (!row) return null;
    const segments: string[] = [];
    let folderId = row.folderId;
    while (folderId) {
      const folder = this.backing.folders.get(folderId);
      if (!folder || folder.deletedAt !== null) break;
      segments.unshift(folder.name);
      folderId = folder.parentId;
    }
    segments.push(row.extension ? `${row.name}.${row.extension}` : row.name);
    return {
      contextSourceId: row.contextSourceId,
      document: this.publicDocument(row),
      path: segments.join("/"),
      active: row.deletedAt === null && isContentDocumentKind(row.kind),
    };
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    if (
      hasOppositeEntry(
        this.backing,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
        "file",
      )
    )
      throw new ContextEntryConflictError();
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    if (existing) {
      throw new Error(
        `Duplicate binary document: ${input.name}.${input.extension} in folder ${input.folderId ?? "(root)"}`,
      );
    }
    const doc: DocumentRow = {
      id: input.id ?? crypto.randomUUID(),
      contextSourceId: this.sourceId,
      kind: DOCUMENT_KINDS.content,
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
      markdown: "",
      fileType: input.fileType,
      filetype: null,
      storageUrl: input.storageUrl,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      updatedAt: this.nextTimestamp(),
      provisionalName: false,
      deletedAt: null,
    };
    this.backing.documents.set(doc.id, doc);
    claimLocation(
      this.backing,
      doc.contextSourceId,
      doc.folderId,
      doc.extension ? `${doc.name}.${doc.extension}` : doc.name,
    );
    return this.publicDocument(doc);
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument> {
    if (
      hasOppositeEntry(
        this.backing,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
        "file",
      )
    )
      throw new ContextEntryConflictError();
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    if (existing) {
      const row = this.backing.documents.get(existing.id);
      if (!row) throw new Error(`Document row disappeared: ${existing.id}`);
      const updated: DocumentRow = {
        ...row,
        markdown: "",
        fileType: input.fileType,
        filetype: null,
        storageUrl: input.storageUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        updatedAt: this.nextTimestamp(),
      };
      this.backing.documents.set(updated.id, updated);
      return this.publicDocument(updated);
    }
    return this.createBinaryDocument(input);
  }

  async listFolders(parentId: string | null): Promise<ContextFolder[]> {
    const out: ContextFolder[] = [];
    for (const folder of this.backing.folders.values()) {
      if (
        folder.contextSourceId === this.sourceId &&
        folder.deletedAt === null &&
        folder.parentId === parentId
      ) {
        out.push(this.publicFolder(folder));
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listDocuments(folderId: string | null): Promise<ContextDocument[]> {
    const out: ContextDocument[] = [];
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === this.sourceId &&
        isContentDocumentKind(doc.kind) &&
        doc.deletedAt === null &&
        doc.folderId === folderId
      ) {
        out.push(this.publicDocument(doc));
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
