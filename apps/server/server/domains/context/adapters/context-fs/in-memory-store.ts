import {
  DOCUMENT_KINDS,
  type DocumentKind,
  isContentDocumentKind,
} from "@meridian/database/schema";

/**
 * In-memory ContextFS persistence for tests and lightweight composition.
 * It provides both the per-source ContextDocumentStore CRUD surface and the
 * backing-scoped ContextTreeMutationStore used by move/delete CAS tests. A
 * shared backing map mirrors Postgres: moving across sources changes row
 * ownership instead of copying documents.
 */

import { Err, Ok, type Result } from "../../../../shared/result.js";
import { parseFilename, splitPath } from "../../context/paths.js";
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
  CreateBinaryDocumentInput,
  UpsertBinaryDocumentInput,
  UpsertDocumentInput,
} from "../../ports/context-document-store.js";
import {
  CONTEXT_ROOT_DIRECTORY_ID,
  type ContextLocationToken,
  type ContextTargetExpectation,
  type ContextTreeDeleteResult,
  type ContextTreeMoveCommand,
  type ContextTreeMutationError,
  type ContextTreeMutationResult,
  type ContextTreeMutationStore,
} from "../../ports/context-tree-mutation-store.js";

type FolderRow = ContextFolder & {
  contextSourceId: string;
  deletedAt: string | null;
  updatedAt: string;
};
type DocumentRow = ContextDocument & {
  contextSourceId: string;
  deletedAt: string | null;
  kind: DocumentKind;
};

export interface InMemoryContextDocumentStoreBacking {
  folders: Map<string, FolderRow>;
  documents: Map<string, DocumentRow>;
  clock: { value: number };
}

export interface InMemoryContextDocumentStoreOptions {
  sourceId?: string;
  backing?: InMemoryContextDocumentStoreBacking;
}

export function createInMemoryContextDocumentStoreBacking(): InMemoryContextDocumentStoreBacking {
  return { folders: new Map(), documents: new Map(), clock: { value: 0 } };
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

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const foldersSnapshot = new Map(
      [...this.backing.folders].map(([id, row]) => [id, { ...row }] as const),
    );
    const documentsSnapshot = new Map(
      [...this.backing.documents].map(([id, row]) => [id, { ...row }] as const),
    );
    const clockSnapshot = this.backing.clock.value;
    try {
      return await operation();
    } catch (error) {
      this.backing.folders.clear();
      for (const entry of foldersSnapshot) this.backing.folders.set(...entry);
      this.backing.documents.clear();
      for (const entry of documentsSnapshot) this.backing.documents.set(...entry);
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

  async updateDocumentProjection(documentId: string, markdown: string): Promise<boolean> {
    const row = this.backing.documents.get(documentId);
    if (!row || !isContentDocumentKind(row.kind) || row.deletedAt !== null) return false;
    row.markdown = markdown;
    row.sizeBytes = Buffer.byteLength(markdown, "utf8");
    row.updatedAt = this.nextTimestamp();
    return true;
  }

  async upsertDocument(input: UpsertDocumentInput): Promise<ContextDocument> {
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    if (existing && existing.fileType !== null) {
      throw new Error(`Cannot replace binary document with tracked text: ${existing.id}`);
    }
    const sizeBytes = Buffer.byteLength(input.markdown, "utf8");
    if (existing) {
      const row = this.backing.documents.get(existing.id);
      if (!row) throw new Error(`Document row disappeared: ${existing.id}`);
      const updated: DocumentRow = {
        ...row,
        markdown: input.markdown,
        fileType: null,
        filetype: input.filetype,
        storageUrl: null,
        mimeType: null,
        sizeBytes,
        updatedAt: this.nextTimestamp(),
      };
      this.backing.documents.set(updated.id, updated);
      return this.publicDocument(updated);
    }
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
      deletedAt: null,
    };
    this.backing.documents.set(doc.id, doc);
    return this.publicDocument(doc);
  }

  async createDocumentIfAbsent(input: UpsertDocumentInput): Promise<ContextDocument | null> {
    if (await this.findDocument(input.folderId, input.name, input.extension)) return null;
    return this.upsertDocument(input);
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
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
      deletedAt: null,
    };
    this.backing.documents.set(doc.id, doc);
    return this.publicDocument(doc);
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument> {
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

const MISSING_FOLDER = Symbol("missing-folder");

type FolderResolution = string | null | typeof MISSING_FOLDER;

function normalizeTreePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function treePathSegments(path: string): string[] {
  return normalizeTreePath(path).split("/").filter(Boolean);
}

function treeBasename(path: string): string {
  const segments = treePathSegments(path);
  return segments[segments.length - 1] ?? "";
}

function treeDirname(path: string): string {
  const segments = treePathSegments(path);
  segments.pop();
  return segments.join("/");
}

function sameLocation(a: ContextLocationToken | null, b: ContextLocationToken | null): boolean {
  return (
    a?.kind === b?.kind &&
    a?.nodeId === b?.nodeId &&
    a?.sourceId === b?.sourceId &&
    a?.path === b?.path &&
    a?.revision === b?.revision &&
    (a?.kind !== "file" || b?.kind !== "file" || a.filetype === b.filetype)
  );
}

/**
 * Backing-scoped in-memory implementation of the atomic move/delete CAS port.
 * Snapshots are intentionally coarse: this adapter is test-only, and a whole
 * backing rollback on failure matches a database transaction for mutator-owned
 * writes only — concurrent store writes interleaved via the destructive hook
 * persist when the mutator returns Err without having applied its own changes.
 */
export class InMemoryContextTreeMutationStore implements ContextTreeMutationStore {
  private beforeDestructiveWrite: (() => void | Promise<void>) | null = null;
  private mutatorTouchedBacking = false;

  constructor(private readonly backing: InMemoryContextDocumentStoreBacking) {}

  /** Test hook: runs after CAS rechecks, immediately before destructive writes. */
  setBeforeDestructiveWrite(hook: (() => void | Promise<void>) | null): void {
    this.beforeDestructiveWrite = hook;
  }

  private markMutatorWrite(): void {
    this.mutatorTouchedBacking = true;
  }

  private async runBeforeDestructiveWrite(): Promise<void> {
    await this.beforeDestructiveWrite?.();
  }

  private nextTimestamp(): string {
    this.backing.clock.value += 1;
    return new Date(this.backing.clock.value * 1000).toISOString();
  }

  private snapshot() {
    return {
      folders: new Map([...this.backing.folders].map(([id, row]) => [id, { ...row }] as const)),
      documents: new Map([...this.backing.documents].map(([id, row]) => [id, { ...row }] as const)),
      clock: this.backing.clock.value,
    };
  }

  private restore(snapshot: ReturnType<InMemoryContextTreeMutationStore["snapshot"]>): void {
    this.backing.folders.clear();
    for (const entry of snapshot.folders) this.backing.folders.set(...entry);
    this.backing.documents.clear();
    for (const entry of snapshot.documents) this.backing.documents.set(...entry);
    this.backing.clock.value = snapshot.clock;
  }

  private async atomic<T>(
    operation: () => Promise<Result<T, ContextTreeMutationError>>,
  ): Promise<Result<T, ContextTreeMutationError>> {
    const snapshot = this.snapshot();
    this.mutatorTouchedBacking = false;
    try {
      const result = await operation();
      if (!result.ok && this.mutatorTouchedBacking) this.restore(snapshot);
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private async findFolderId(sourceId: string, dir: readonly string[]): Promise<FolderResolution> {
    let parentId: string | null = null;
    for (const name of dir) {
      let found: FolderRow | null = null;
      for (const folder of this.backing.folders.values()) {
        if (
          folder.contextSourceId === sourceId &&
          folder.deletedAt === null &&
          folder.parentId === parentId &&
          folder.name === name
        ) {
          found = folder;
          break;
        }
      }
      if (!found) return MISSING_FOLDER;
      parentId = found.id;
    }
    return parentId;
  }

  private async ensureFolderPath(sourceId: string, dir: readonly string[]): Promise<string | null> {
    let parentId: string | null = null;
    for (const name of dir) {
      const existing = await this.findDirectFolder(sourceId, parentId, name);
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const folder: FolderRow = {
        id: crypto.randomUUID(),
        contextSourceId: sourceId,
        parentId,
        name,
        deletedAt: null,
        updatedAt: this.nextTimestamp(),
      };
      this.backing.folders.set(folder.id, folder);
      this.markMutatorWrite();
      parentId = folder.id;
    }
    return parentId;
  }

  private async findDirectFolder(
    sourceId: string,
    parentId: string | null,
    name: string,
  ): Promise<FolderRow | null> {
    for (const folder of this.backing.folders.values()) {
      if (
        folder.contextSourceId === sourceId &&
        folder.deletedAt === null &&
        folder.parentId === parentId &&
        folder.name === name
      ) {
        return folder;
      }
    }
    return null;
  }

  private async findFolderAtPath(sourceId: string, path: string): Promise<FolderRow | null> {
    const segments = treePathSegments(path);
    if (segments.length === 0) return null;
    const folderId = await this.findFolderId(sourceId, segments);
    if (folderId === MISSING_FOLDER || folderId === null) return null;
    return this.backing.folders.get(folderId) ?? null;
  }

  private async findDocumentAtPath(sourceId: string, path: string): Promise<DocumentRow | null> {
    const { dir, filename } = splitPath(normalizeTreePath(path));
    if (!filename) return null;
    const folderId = await this.findFolderId(sourceId, dir);
    if (folderId === MISSING_FOLDER) return null;
    const { name, extension } = parseFilename(filename);
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === sourceId &&
        isContentDocumentKind(doc.kind) &&
        doc.deletedAt === null &&
        doc.folderId === folderId &&
        doc.name === name &&
        doc.extension === extension
      ) {
        return doc;
      }
    }
    return null;
  }

  async inspect(sourceId: string, path: string): Promise<ContextLocationToken | null> {
    const normalized = normalizeTreePath(path);
    if (!normalized) {
      return {
        kind: "directory",
        nodeId: CONTEXT_ROOT_DIRECTORY_ID,
        sourceId,
        path: "",
        revision: "",
      };
    }
    const doc = await this.findDocumentAtPath(sourceId, normalized);
    if (doc) {
      return {
        kind: "file",
        nodeId: doc.id,
        sourceId,
        path: normalized,
        revision: doc.updatedAt,
        filetype: doc.filetype,
      };
    }
    const folder = await this.findFolderAtPath(sourceId, normalized);
    if (folder) {
      return {
        kind: "directory",
        nodeId: folder.id,
        sourceId,
        path: normalized,
        revision: folder.updatedAt,
      };
    }
    return null;
  }

  private async expectationStillMatches(
    sourceId: string,
    path: string,
    expectation: ContextTargetExpectation,
  ): Promise<boolean> {
    const inspected = await this.inspect(sourceId, path);
    return expectation.state === "absent"
      ? inspected === null
      : sameLocation(inspected, expectation.token);
  }

  private collectSubtree(folderId: string, sourceId: string): Set<string> {
    const subtree = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of this.backing.folders.values()) {
        if (
          folder.contextSourceId === sourceId &&
          folder.deletedAt === null &&
          folder.parentId !== null &&
          subtree.has(folder.parentId) &&
          !subtree.has(folder.id)
        ) {
          subtree.add(folder.id);
          changed = true;
        }
      }
    }
    return subtree;
  }

  private documentIdsInSubtree(subtree: ReadonlySet<string>, sourceId: string): string[] {
    const ids: string[] = [];
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === sourceId &&
        isContentDocumentKind(doc.kind) &&
        doc.deletedAt === null &&
        doc.folderId !== null &&
        subtree.has(doc.folderId)
      ) {
        ids.push(doc.id);
      }
    }
    return ids;
  }

  private folderHasLiveChildren(folderId: string, sourceId: string): boolean {
    for (const folder of this.backing.folders.values()) {
      if (
        folder.contextSourceId === sourceId &&
        folder.deletedAt === null &&
        folder.parentId === folderId
      ) {
        return true;
      }
    }
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === sourceId &&
        isContentDocumentKind(doc.kind) &&
        doc.deletedAt === null &&
        doc.folderId === folderId
      ) {
        return true;
      }
    }
    return false;
  }

  async commitMove(
    input: ContextTreeMoveCommand,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>> {
    return this.atomic(async () => {
      const destinationPath = normalizeTreePath(input.destinationPath);
      const targetBasename = treeBasename(destinationPath);
      if (!targetBasename || input.source.nodeId === CONTEXT_ROOT_DIRECTORY_ID) {
        return Err({ code: "invalid_operation" });
      }

      const sourceNow = await this.inspect(input.source.sourceId, input.source.path);
      if (!sameLocation(sourceNow, input.source)) return Err({ code: "stale_source" });

      if (
        !(await this.expectationStillMatches(
          input.destinationSourceId,
          destinationPath,
          input.expectedTarget,
        ))
      ) {
        return Err({ code: "stale_target" });
      }

      const targetToken =
        input.expectedTarget.state === "occupied" ? input.expectedTarget.token : null;
      if (targetToken) {
        if (targetToken.kind !== input.source.kind) return Err({ code: "invalid_operation" });
        if (targetToken.nodeId === input.source.nodeId) return Err({ code: "invalid_operation" });
        if (!input.overwrite || input.source.kind === "directory") {
          return Err({ code: "conflict" });
        }
      }

      const targetParentPath = treeDirname(destinationPath);
      if (
        input.source.kind === "directory" &&
        input.source.sourceId === input.destinationSourceId &&
        (targetParentPath === input.source.path ||
          targetParentPath.startsWith(`${input.source.path}/`))
      ) {
        return Err({ code: "invalid_operation" });
      }

      const destParentId = await this.ensureFolderPath(
        input.destinationSourceId,
        treePathSegments(targetParentPath),
      );

      const now = this.nextTimestamp();
      if (input.source.kind === "file") {
        if (targetToken?.kind === "file") {
          await this.runBeforeDestructiveWrite();
          const targetRow = this.backing.documents.get(targetToken.nodeId);
          if (!targetRow || targetRow.deletedAt !== null) return Err({ code: "stale_target" });
          if (targetRow.updatedAt !== targetToken.revision) return Err({ code: "stale_target" });
          targetRow.deletedAt = now;
          targetRow.updatedAt = now;
          this.markMutatorWrite();
        }
        const { name, extension } = parseFilename(targetBasename);
        await this.runBeforeDestructiveWrite();
        const sourceRow = this.backing.documents.get(input.source.nodeId);
        if (!sourceRow || sourceRow.deletedAt !== null) return Err({ code: "stale_source" });
        if (sourceRow.updatedAt !== input.source.revision) return Err({ code: "stale_source" });
        sourceRow.contextSourceId = input.destinationSourceId;
        sourceRow.folderId = destParentId;
        sourceRow.name = name;
        sourceRow.extension = extension;
        if (input.destinationFiletype != null) {
          sourceRow.filetype = input.destinationFiletype;
        }
        sourceRow.updatedAt = this.nextTimestamp();
        this.markMutatorWrite();
        return Ok({ movedNodeId: sourceRow.id });
      }

      const root = this.backing.folders.get(input.source.nodeId);
      if (!root || root.deletedAt !== null) return Err({ code: "stale_source" });
      await this.runBeforeDestructiveWrite();
      const movedRoot = this.backing.folders.get(input.source.nodeId);
      if (!movedRoot || movedRoot.deletedAt !== null) return Err({ code: "stale_source" });
      if (movedRoot.updatedAt !== input.source.revision) return Err({ code: "stale_source" });
      const subtree = this.collectSubtree(movedRoot.id, input.source.sourceId);
      const movedDocumentIds = this.documentIdsInSubtree(subtree, input.source.sourceId);
      for (const id of subtree) {
        const folder = this.backing.folders.get(id);
        if (!folder) continue;
        folder.contextSourceId = input.destinationSourceId;
        folder.updatedAt = this.nextTimestamp();
      }
      movedRoot.parentId = destParentId;
      movedRoot.name = targetBasename;
      movedRoot.updatedAt = this.nextTimestamp();
      for (const documentId of movedDocumentIds) {
        const doc = this.backing.documents.get(documentId);
        if (!doc) continue;
        doc.contextSourceId = input.destinationSourceId;
        doc.updatedAt = this.nextTimestamp();
      }
      this.markMutatorWrite();
      return Ok({ movedNodeId: movedRoot.id });
    });
  }

  async commitDelete(
    token: ContextLocationToken,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>> {
    return this.atomic(async () => {
      if (token.nodeId === CONTEXT_ROOT_DIRECTORY_ID) return Err({ code: "invalid_operation" });
      const current = await this.inspect(token.sourceId, token.path);
      if (!sameLocation(current, token)) return Err({ code: "stale_source" });
      const now = this.nextTimestamp();
      if (token.kind === "file") {
        await this.runBeforeDestructiveWrite();
        const doc = this.backing.documents.get(token.nodeId);
        if (!doc || !isContentDocumentKind(doc.kind) || doc.deletedAt !== null) {
          return Err({ code: "stale_source" });
        }
        if (doc.updatedAt !== token.revision) return Err({ code: "stale_source" });
        doc.deletedAt = now;
        doc.updatedAt = now;
        this.markMutatorWrite();
        return Ok({ deletedNodeId: doc.id });
      }
      const folder = this.backing.folders.get(token.nodeId);
      if (!folder || folder.deletedAt !== null) return Err({ code: "stale_source" });
      if (this.folderHasLiveChildren(folder.id, token.sourceId)) {
        return Err({ code: "invalid_operation" });
      }
      await this.runBeforeDestructiveWrite();
      const folderNow = this.backing.folders.get(token.nodeId);
      if (!folderNow || folderNow.deletedAt !== null) return Err({ code: "stale_source" });
      if (folderNow.updatedAt !== token.revision) return Err({ code: "stale_source" });
      if (this.folderHasLiveChildren(folderNow.id, token.sourceId)) {
        return Err({ code: "invalid_operation" });
      }
      folderNow.deletedAt = now;
      folderNow.updatedAt = now;
      this.markMutatorWrite();
      return Ok({ deletedNodeId: folderNow.id });
    });
  }
}
