import {
  allocateFilename,
  folderDocumentName,
  parseDocumentFilename,
  type RetractionCause,
} from "@meridian/contracts/protocol";
/**
 * In-memory ContextFS persistence for tests and lightweight composition.
 * It provides both the per-source ContextDocumentStore CRUD surface and the
 * backing-scoped ContextTreeMutationStore used by move/delete CAS tests. A
 * shared backing map mirrors Postgres: moving across sources changes row
 * ownership instead of copying documents.
 */

import { renderFilename, splitPath } from "../../context/paths.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
  type ContextFolder,
  type CreateBinaryDocumentInput,
  type CreateDocumentInput,
  type LiveDocumentCreation,
} from "../../ports/context-document-store.js";
import type { LiveCreateCandidate } from "../../tree/hidden-node-types.js";
import type { PathResolution, TreeView } from "../../tree/tree-view.js";

export type FolderRow = ContextFolder & {
  contextSourceId: string;
  deletedAt: string | null;
  updatedAt: string;
};
export type DocumentRow = ContextDocument & {
  deletionReason?: "deleted" | "discarded";
  deletedByUserId?: string | null;
  deletionCause?: RetractionCause | null;

  contextSourceId: string;
  deletedAt: string | null;
};

export interface InMemoryContextDocumentStoreBacking {
  previousLocations: Map<string, string>;
  /** Joined-create forwards, `from → to`. */
  forwards: Map<string, string>;
  folders: Map<string, FolderRow>;
  documents: Map<string, DocumentRow>;
  projections: Map<string, string>;
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
    forwards: new Map(),
    folders: new Map(),
    documents: new Map(),
    projections: new Map(),
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
    if (!row || row.deletedAt !== null) return [];
    const { contextSourceId: _contextSourceId, deletedAt: _deletedAt, ...document } = row;
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
          folderDocumentName(row.name) === filename &&
          row.deletedAt === null,
      )
    : [...backing.documents.values()].some(
        (row) =>
          row.contextSourceId === sourceId &&
          row.folderId === parentId &&
          renderFilename(row.name, row.extension) === folderDocumentName(filename) &&
          row.deletedAt === null,
      );
}

function locationPath(
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

export function memoryFileLocations(
  backing: InMemoryContextDocumentStoreBacking,
  sourceId: string,
) {
  return [...backing.documents.values()]
    .filter((row) => row.contextSourceId === sourceId && row.deletedAt === null)
    .map((row) => ({
      id: row.id,
      path: locationPath(
        backing,
        row.folderId,
        row.extension ? `${row.name}.${row.extension}` : row.name,
      ),
    }));
}

export function recordMemoryMove(
  backing: InMemoryContextDocumentStoreBacking,
  sourceId: string,
  destinationSourceId: string,
  previous: ReturnType<typeof memoryFileLocations>,
): void {
  const current = memoryFileLocations(backing, destinationSourceId);
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const old of previous) {
    const next = byId.get(old.id);
    if (next && (sourceId !== destinationSourceId || next.path !== old.path)) {
      backing.previousLocations.set(JSON.stringify([sourceId, old.path]), old.id);
    }
  }
  for (const entry of current)
    backing.previousLocations.delete(JSON.stringify([destinationSourceId, entry.path]));
  for (const folder of backing.folders.values()) {
    if (folder.contextSourceId === destinationSourceId && folder.deletedAt === null)
      claimLocation(backing, destinationSourceId, folder.parentId, folder.name);
  }
}

function normalizeTreePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function treePathSegments(path: string): string[] {
  return normalizeTreePath(path).split("/").filter(Boolean);
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
    const { contextSourceId: _contextSourceId, deletedAt: _deletedAt, ...out } = doc;
    return { ...out };
  }

  async contextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async existingContextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const foldersSnapshot = new Map(
      [...this.backing.folders].map(([id, row]) => [id, { ...row }] as const),
    );
    const documentsSnapshot = new Map(
      [...this.backing.documents].map(([id, row]) => [id, { ...row }] as const),
    );
    const previousLocationsSnapshot = new Map(this.backing.previousLocations);
    const projectionsSnapshot = new Map(this.backing.projections);
    const clockSnapshot = this.backing.clock.value;
    try {
      return await operation();
    } catch (error) {
      this.backing.folders.clear();
      for (const entry of foldersSnapshot) this.backing.folders.set(...entry);
      this.backing.documents.clear();
      for (const entry of documentsSnapshot) this.backing.documents.set(...entry);
      this.backing.previousLocations = previousLocationsSnapshot;
      this.backing.projections = projectionsSnapshot;
      this.backing.clock.value = clockSnapshot;
      throw error;
    }
  }

  async resolveFolderAt(
    _view: TreeView,
    path: string,
  ): Promise<PathResolution<ContextFolder | null>> {
    let folder: ContextFolder | null = null;
    for (const name of treePathSegments(path)) {
      folder = this.findFolderRecord(folder?.id ?? null, name);
      if (!folder) return { kind: "not_found" };
    }
    return { kind: "found", node: folder };
  }

  async resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>> {
    const { dir, filename } = splitPath(normalizeTreePath(path));
    const parsed = parseDocumentFilename(filename);
    if (!parsed.ok) return { kind: "not_found" };
    const folder = await this.resolveFolderAt(view, dir.join("/"));
    if (folder.kind !== "found") return { kind: "not_found" };
    const document = this.findDocumentRecord(
      folder.node?.id ?? null,
      parsed.value.name,
      parsed.value.extension,
    );
    return document ? { kind: "found", node: document } : { kind: "not_found" };
  }

  private findFolderRecord(parentId: string | null, name: string): ContextFolder | null {
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

  async ensureFolderPath(dir: readonly string[]): Promise<string | null> {
    let parentId: string | null = null;
    for (const name of dir) parentId = (await this.createFolder(parentId, name)).id;
    return parentId;
  }

  async findFolderIdentity(
    id: string,
  ): Promise<{ status: "live"; path: readonly string[] } | { status: "unreachable" } | null> {
    const held = this.backing.folders.get(id);
    if (held) {
      // Another source's folder is found by that source's own reader, not this one.
      if (held.contextSourceId !== this.sourceId) return null;
      if (held.deletedAt !== null) return { status: "unreachable" };
      return {
        status: "live",
        path: locationPath(this.backing, held.parentId, held.name).split("/"),
      };
    }
    const document = this.backing.documents.get(id);
    return document?.contextSourceId === this.sourceId ? { status: "unreachable" } : null;
  }

  async createFolderIfAbsent(input: {
    parentId: string | null;
    name: string;
    id: string;
    position?: unknown;
  }) {
    const sameSource = await this.findFolderIdentity(input.id);
    if (sameSource) {
      if (sameSource.status === "unreachable") throw new ContextEntryConflictError("folder");
      return { status: "already-exists" as const, folderId: input.id, path: sameSource.path };
    }
    // The catalog's entry-id space is global, and another source holding the id is final too.
    if (this.backing.folders.has(input.id) || this.backing.documents.has(input.id))
      throw new ContextEntryConflictError("folder");
    const name = await allocateFilename({ kind: "folder", name: input.name }, ({ filename }) =>
      Promise.resolve(
        this.findFolderRecord(input.parentId, filename) !== null ||
          hasOppositeEntry(this.backing, this.sourceId, input.parentId, filename, "folder"),
      ),
    );
    const folder: FolderRow = {
      id: input.id,
      contextSourceId: this.sourceId,
      parentId: input.parentId,
      name,
      deletedAt: null,
      updatedAt: this.nextTimestamp(),
    };
    this.backing.folders.set(folder.id, folder);
    claimLocation(this.backing, folder.contextSourceId, folder.parentId, folder.name);
    return {
      status: "created" as const,
      folderId: folder.id,
      path: locationPath(this.backing, folder.parentId, folder.name).split("/"),
    };
  }

  private async createFolder(parentId: string | null, name: string): Promise<ContextFolder> {
    if (hasOppositeEntry(this.backing, this.sourceId, parentId, name, "folder"))
      throw new ContextEntryConflictError("file");
    const existing = this.findFolderRecord(parentId, name);
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
    return this.findDocumentRecord(folderId, name, extension);
  }

  private findDocumentRecord(
    folderId: string | null,
    name: string,
    extension: string,
  ): ContextDocument | null {
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === this.sourceId &&
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

  async createDocumentRecordIfAbsent(
    input: CreateDocumentInput,
  ): Promise<LiveDocumentCreation | null> {
    if (
      hasOppositeEntry(
        this.backing,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
        "file",
      )
    )
      throw new ContextEntryConflictError("folder");
    if (this.backing.documents.has(input.id ?? "")) return null;
    for (const row of this.backing.documents.values()) {
      if (
        row.contextSourceId === this.sourceId &&
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
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
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
    this.backing.projections.set(doc.id, input.markdown);
    claimLocation(
      this.backing,
      doc.contextSourceId,
      doc.folderId,
      doc.extension ? `${doc.name}.${doc.extension}` : doc.name,
    );
    return { document: this.publicDocument(doc), revealed: false };
  }

  async findForward(fromId: string): Promise<string | null> {
    return this.backing.forwards.get(fromId) ?? null;
  }

  async listHiddenNames(): Promise<string[]> {
    // In memory nothing is ever hidden: branches and the tree view are Postgres's.
    return [];
  }

  async findDocumentLastLocation(documentId: string) {
    const row = this.backing.documents.get(documentId);
    if (!row || row.contextSourceId !== this.sourceId) return null;
    const located = await this.findDocumentById({ kind: "live" }, documentId);
    return {
      path: located?.path ?? renderFilename(row.name, row.extension),
      name: renderFilename(row.name, row.extension),
      deleted: row.deletedAt !== null,
    };
  }

  async findLiveCreateCandidate(): Promise<LiveCreateCandidate> {
    return { kind: "none" };
  }

  async findDocumentById(_view: TreeView, documentId: string) {
    const row = this.backing.documents.get(documentId);
    if (!row || row.deletedAt !== null) return null;
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
      throw new ContextEntryConflictError("folder");
    const existing = this.findDocumentRecord(input.folderId, input.name, input.extension);
    if (existing) {
      throw new Error(
        `Duplicate binary document: ${input.name}.${input.extension} in folder ${input.folderId ?? "(root)"}`,
      );
    }
    const doc: DocumentRow = {
      id: input.id ?? crypto.randomUUID(),
      contextSourceId: this.sourceId,
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
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

  async readProjections(ids: string[]): Promise<Map<string, string>> {
    return new Map(
      ids.flatMap((id) => {
        const markdown = this.backing.projections.get(id);
        return markdown === undefined ? [] : [[id, markdown] as const];
      }),
    );
  }

  async parentOrderPolicy(_view: TreeView, _parentId: string | null) {
    return "default" as const;
  }

  async listFolders(_view: TreeView, parentId: string | null): Promise<ContextFolder[]> {
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

  async listDocuments(_view: TreeView, folderId: string | null): Promise<ContextDocument[]> {
    const out: ContextDocument[] = [];
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === this.sourceId &&
        doc.deletedAt === null &&
        doc.folderId === folderId
      ) {
        out.push(this.publicDocument(doc));
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
