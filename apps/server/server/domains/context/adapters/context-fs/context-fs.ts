/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`manuscript`/`kb`/`scratch`/`user`/`uploads`). It hides the document-store +
 * Yjs backing behind path-oriented filesystem operations; move/delete go through
 * the injected ContextTreeMutationStore for location CAS semantics.
 */

import {
  classifyFiletype,
  type Filetype,
  filetypeForKnownPath,
  filetypeForPath,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import { isUuid } from "../../../../lib/uuid.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type {
  BranchPeerShadowAccess,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import { editCollabMarkdown, writeCollabMarkdown } from "../../context/collab-document-sync.js";
import { joinPath, parseFilename, renderFilename, splitPath } from "../../context/paths.js";
import type {
  AdapterDeleteResult,
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterMoveResult,
  AdapterSearchHit,
  ContextSchemeAdapter,
  ContextTreeAdapter,
  SchemeCapabilities,
} from "../../ports/context-adapter.js";
import type { ContextDocument, ContextDocumentStore } from "../../ports/context-document-store.js";
import type {
  ContextCreateUntitledDocumentOptions,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
} from "../../ports/context-port.js";
import type {
  ContextLocationToken,
  ContextTreeMutationError,
  ContextTreeMutationStore,
  PreparedContextMove,
} from "../../ports/context-tree-mutation-store.js";
import { firstLineMatch } from "./match.js";

export interface ContextFSDeps {
  store: ContextDocumentStore;
  mutationStore: ContextTreeMutationStore;
  documentSync: MarkdownDocumentStore;
  /** Scheme name used by the router for this filesystem instance. */
  scheme: ContextScheme;
  manifestView?: {
    projectId: string;
    workId?: string | null;
    threadId?: string | null;
    responseId?: string | null;
  };
}

/** Folder-id of `null` is the source root; `MISSING` means the path is absent. */
const MISSING = Symbol("missing-folder");
const DEFAULT_EDITABLE_FILETYPE = "markdown";
const UNTITLED_NAME_PATTERN = /^Untitled (\d+)$/;
const UNTITLED_ALLOCATION_ATTEMPTS = 32;

function trackedFiletypeForPath(path: string): Result<Filetype, AdapterFault> {
  const filetype = filetypeForPath(path);
  if (classifyFiletype(filetype).kind === "tracked") return Ok(filetype);
  return Err(binaryTrackedWriteFault(path));
}

function binaryTrackedWriteFault(path: string): AdapterFault {
  return {
    code: "invalid_operation",
    message: `Cannot create or write ${path} as a tracked text document; binary content must use the upload flow`,
  };
}

function trackedSchemaForPersistedFiletype(
  filetype: string | null | undefined,
): Result<YjsTrackedSchemaType, AdapterFault> {
  const classification = classifyFiletype(filetype);
  if (classification.kind === "tracked") return Ok(classification.schemaType);
  if (classification.kind === "unknown") return Ok("document");
  return Err({
    code: "io_error",
    message: `Tracked document has registered ${classification.kind} filetype: ${filetype}`,
  });
}

function moveFiletypeTransition(
  source: Extract<ContextLocationToken, { kind: "file" }>,
  destinationPath: string,
): Result<Filetype | null, AdapterFault> {
  if (source.filetype === null) {
    const knownDestinationFiletype = filetypeForKnownPath(destinationPath);
    if (knownDestinationFiletype === null) return Ok(null);
    const destination = classifyFiletype(knownDestinationFiletype);
    if (destination.kind !== "tracked") return Ok(null);
    return Err({
      code: "invalid_operation",
      message: `Cannot rename storage-backed file ${source.path} to ${destinationPath} because tracked documents require a Yjs schema`,
    });
  }

  const sourceSchema = trackedSchemaForPersistedFiletype(source.filetype);
  if (!sourceSchema.ok) return sourceSchema;
  const destinationFiletype = filetypeForPath(destinationPath);
  const destination = classifyFiletype(destinationFiletype);
  if (destination.kind !== "tracked") {
    return Err({
      code: "invalid_operation",
      message: `Cannot rename tracked document ${source.path} to ${destinationPath} because binary and custom files use a different storage model`,
    });
  }
  if (destination.schemaType !== sourceSchema.value) {
    return Err({
      code: "invalid_operation",
      message: `Cannot rename ${source.path} to ${destinationPath} because changing the Yjs schema from ${sourceSchema.value} to ${destination.schemaType} requires an explicit conversion`,
    });
  }
  return Ok(destinationFiletype);
}

/**
 * Store-backed file tree for project and work context schemes.
 * Owns path ↔ folder-tree resolution and folder auto-creation; delegates
 * single-node persistence to a {@link ContextDocumentStore}.
 *
 * Content is Yjs-canonical: folder tree and `markdown_projection` stay in the
 * store, but read/write content flows through the collab domain. The store's
 * markdown is only a search/listing projection cache.
 *
 * v1 semantics are last-write-wins:
 * `ensureFolderId` find-then-create and the store's find-then-upsert are not
 * atomic, so two concurrent writers to the same new path can race into a
 * unique-constraint violation. The router converts that rejection into an
 * `io_error` rather than crashing. Concurrency-safe upsert (ON CONFLICT) is
 * deferred to the Yjs-merge work in Phase 2.
 */
export class ContextFS implements ContextSchemeAdapter {
  readonly name: string;
  readonly capabilities: SchemeCapabilities = { writable: true, searchable: true };

  private readonly store: ContextDocumentStore;
  private readonly mutationStore: ContextTreeMutationStore;
  private readonly documentSync: MarkdownDocumentStore;
  private readonly manifestView?: ContextFSDeps["manifestView"];

  readonly tree: ContextTreeAdapter = {
    inspectMovable: (path) => this.inspectMovable(path),
    commitProvisionalGraduation: (source) => this.commitProvisionalGraduation(source),
    commitPreparedMove: (prepared) => this.commitPreparedMove(prepared),
    commitPreparedDelete: (token) => this.commitPreparedDelete(token),
  };

  constructor(deps: ContextFSDeps) {
    this.store = deps.store;
    this.mutationStore = deps.mutationStore;
    this.documentSync = deps.documentSync;
    this.manifestView = deps.manifestView;
    this.name = deps.scheme;
  }

  private syncFault(error: SyncError): AdapterFault {
    switch (error.code) {
      case "not_found":
        return {
          code: "io_error",
          message: `Yjs document not found: ${error.documentId}`,
        };
      case "checkpoint_not_found":
        return { code: "io_error", message: `Yjs checkpoint not found: ${error.checkpointId}` };
      case "corrupt_state":
        return { code: "io_error", message: error.message };
    }
  }

  private async finalizeUntitledDocument(documentId: string): Promise<void> {
    await this.store.ensureDocumentMembership(documentId);
    await this.documentSync.ensureDocument(documentId);
  }

  private async persistProjection(
    documentId: string,
    markdown: string,
  ): Promise<Result<void, AdapterFault>> {
    if (await this.store.updateDocumentProjection(documentId, markdown)) return Ok(undefined);
    return Err({
      code: "io_error",
      message: `Document disappeared while persisting its text projection: ${documentId}`,
    });
  }

  /** Resolve a folder chain without creating; `MISSING` if any segment is absent. */
  private async findFolderId(dir: string[]): Promise<string | null | typeof MISSING> {
    let parentId: string | null = null;
    for (const name of dir) {
      const existing = await this.store.findFolder(parentId, name);
      if (!existing) return MISSING;
      parentId = existing.id;
    }
    return parentId;
  }

  /** Resolve a folder chain, creating missing segments. Always returns a folder id. */
  private async ensureFolderId(dir: string[]): Promise<string | null> {
    let parentId: string | null = null;
    for (const name of dir) {
      const existing = await this.store.findFolder(parentId, name);
      parentId = existing ? existing.id : (await this.store.createFolder(parentId, name)).id;
    }
    return parentId;
  }

  async stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) return Ok(null);

    const folderId = await this.findFolderId(dir);
    if (folderId === MISSING) return Ok(null);

    const { name, extension } = parseFilename(filename);
    const doc = await this.store.findDocument(folderId, name, extension);
    if (!doc) return Ok(null);
    if (!(await this.isVisibleDocument(doc.id))) return Ok(null);

    const base = {
      path,
      documentId: doc.id,
      sizeBytes: doc.sizeBytes ?? undefined,
      updatedAt: doc.updatedAt,
    };
    if (doc.fileType === null) {
      const filetype = doc.filetype ?? DEFAULT_EDITABLE_FILETYPE;
      const schemaType = trackedSchemaForPersistedFiletype(filetype);
      if (!schemaType.ok) return schemaType;
      return Ok({
        ...base,
        kind: "tracked",
        filetype,
        schemaType: schemaType.value,
      });
    }
    if (!doc.storageUrl) {
      return {
        ok: false,
        error: { code: "io_error", message: "Binary document is missing object storage URL" },
      };
    }
    return Ok({
      ...base,
      kind: "binary",
      fileType: doc.fileType,
      storageUrl: doc.storageUrl,
      mimeType: doc.mimeType ?? undefined,
    });
  }

  async read(
    path: string,
  ): Promise<Result<{ content: string; documentId?: string } | null, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) return Ok(null);

    const folderId = await this.findFolderId(dir);
    if (folderId === MISSING) return Ok(null);

    const { name, extension } = parseFilename(filename);
    const doc = await this.store.findDocument(folderId, name, extension);
    if (!doc) return Ok(null);
    if (!(await this.isVisibleDocument(doc.id))) return Ok(null);
    if (doc.fileType !== null) {
      return {
        ok: false,
        error: { code: "io_error", message: `Cannot read binary file as markdown: ${path}` },
      };
    }

    const read = await this.readVisibleMarkdown(doc.id);
    if (!read.ok) return { ok: false, error: this.syncFault(read.error) };
    return Ok({ content: read.value, documentId: doc.id });
  }

  async write(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId?: string }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) {
      return { ok: false, error: { code: "io_error", message: "Cannot write to source root" } };
    }
    const resolvedFiletype = trackedFiletypeForPath(filename);
    if (!resolvedFiletype.ok) return resolvedFiletype;
    const folderId = await this.ensureFolderId(dir);
    const { name, extension } = parseFilename(filename);
    const existing = await this.store.findDocument(folderId, name, extension);
    if (existing && existing.fileType !== null) {
      return Err(binaryTrackedWriteFault(path));
    }
    const filetype = existing?.filetype ?? resolvedFiletype.value;
    const doc =
      existing ??
      (await this.store.upsertDocument({ folderId, name, extension, markdown: "", filetype }));

    const write = await writeCollabMarkdown({
      documentSync: this.documentSync,
      documentId: doc.id,
      content,
      provenance: options?.origin,
    });
    if (!write.ok) return write;
    const persisted = await this.persistProjection(doc.id, write.markdown);
    if (!persisted.ok) return persisted;
    return Ok({
      documentId: doc.id,
      markdown: write.markdown,
      updateSeq: write.updateSeq,
    });
  }

  async createTrackedDocument(
    path: string,
    content: string,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
    const resolvedFiletype = trackedFiletypeForPath(filename);
    if (!resolvedFiletype.ok) return resolvedFiletype;
    const filetype = resolvedFiletype.value;
    const folderId = await this.ensureFolderId(dir);
    const { name, extension } = parseFilename(filename);
    const doc = await this.store.createDocumentIfAbsent({
      folderId,
      name,
      extension,
      markdown: "",
      filetype,
    });
    if (!doc) return Err({ code: "conflict" });
    const write = await writeCollabMarkdown({
      documentSync: this.documentSync,
      documentId: doc.id,
      content,
      provenance: options?.origin,
    });
    if (!write.ok) return write;
    const persisted = await this.persistProjection(doc.id, write.markdown);
    if (!persisted.ok) return persisted;
    return Ok({ documentId: doc.id });
  }

  async locateDocument(documentId: string) {
    const sourceId = await this.store.existingContextSourceId();
    if (!sourceId) return Ok(null);
    const located = await this.store.findDocumentById(documentId);
    if (!located || located.contextSourceId !== sourceId || !located.active) return Ok(null);
    return Ok({
      documentId: located.document.id,
      path: located.path,
      name: renderFilename(located.document.name, located.document.extension),
    });
  }

  async createUntitledDocument(
    path: string,
    options: ContextCreateUntitledDocumentOptions,
  ): Promise<
    Result<
      { status: "created" | "already-exists"; documentId: string; path: string; name: string },
      AdapterFault
    >
  > {
    if (!isUuid(options.documentId)) {
      return Err({ code: "invalid_operation", message: "documentId must be a UUID" });
    }

    const sourceId = await this.store.contextSourceId();
    const existing = await this.store.findDocumentById(options.documentId);
    if (existing) {
      if (existing.contextSourceId !== sourceId || !existing.active) {
        return Err({
          code: "conflict",
        });
      }
      await this.finalizeUntitledDocument(existing.document.id);
      return Ok({
        status: "already-exists",
        documentId: existing.document.id,
        path: existing.path,
        name: renderFilename(existing.document.name, existing.document.extension),
      });
    }

    const folderSegments = path.split("/").filter(Boolean);
    const folderId = await this.ensureFolderId(folderSegments);
    for (let attempt = 0; attempt < UNTITLED_ALLOCATION_ATTEMPTS; attempt += 1) {
      const documents = await this.store.listDocuments(folderId);
      const maxNumber = documents.reduce((max, document) => {
        const match = UNTITLED_NAME_PATTERN.exec(document.name);
        if (!match) return max;
        const suffix = Number(match[1]);
        return Number.isSafeInteger(suffix) && suffix < Number.MAX_SAFE_INTEGER
          ? Math.max(max, suffix)
          : max;
      }, 0);
      const name = `Untitled ${maxNumber + 1}`;
      const document = await this.store.createDocumentIfAbsent({
        id: options.documentId,
        folderId,
        name,
        extension: "md",
        markdown: "",
        filetype: "markdown",
        provisionalName: true,
      });
      if (document) {
        await this.finalizeUntitledDocument(document.id);
        return Ok({
          status: "created",
          documentId: document.id,
          path: joinPath(path, renderFilename(document.name, document.extension)),
          name: renderFilename(document.name, document.extension),
        });
      }

      const collision = await this.store.findDocumentById(options.documentId);
      if (!collision) continue;
      if (collision.contextSourceId !== sourceId || !collision.active) {
        return Err({
          code: "conflict",
        });
      }
      await this.finalizeUntitledDocument(collision.document.id);
      return Ok({
        status: "already-exists",
        documentId: collision.document.id,
        path: collision.path,
        name: renderFilename(collision.document.name, collision.document.extension),
      });
    }
    return Err({ code: "conflict" });
  }

  async ensureTrackedDocument(
    path: string,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; created: boolean }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) {
      return { ok: false, error: { code: "io_error", message: "Cannot create source root" } };
    }
    const resolvedFiletype = trackedFiletypeForPath(filename);
    if (!resolvedFiletype.ok) return resolvedFiletype;
    const filetype = resolvedFiletype.value;
    const folderId = await this.ensureFolderId(dir);
    const { name, extension } = parseFilename(filename);
    const existing = await this.store.findDocument(folderId, name, extension);
    if (existing && existing.fileType !== null) {
      return Err(binaryTrackedWriteFault(path));
    }
    const doc =
      existing ??
      (await this.store.upsertDocument({ folderId, name, extension, markdown: "", filetype }));
    const created = !existing;
    if (!created || !options?.deferDocumentSync) await this.documentSync.ensureDocument(doc.id);
    return Ok({ documentId: doc.id, created });
  }

  async edit(
    path: string,
    command: import("../../ports/context-port.js").ContextEditCommand,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId?: string; markdown?: string; updateSeq?: number }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) {
      return { ok: false, error: { code: "io_error", message: "Cannot edit source root" } };
    }
    const folderId = await this.findFolderId(dir);
    if (folderId === MISSING) {
      return { ok: false, error: { code: "io_error", message: `File not found: ${path}` } };
    }

    const { name, extension } = parseFilename(filename);
    const doc = await this.store.findDocument(folderId, name, extension);
    if (!doc) {
      return { ok: false, error: { code: "io_error", message: `File not found: ${path}` } };
    }
    if (doc.fileType !== null) {
      return {
        ok: false,
        error: { code: "io_error", message: `Cannot edit binary file as markdown: ${path}` },
      };
    }

    const edited = await editCollabMarkdown({
      documentSync: this.documentSync,
      documentId: doc.id,
      command,
      provenance: options?.origin,
    });
    if (!edited.ok) return edited;

    const persisted = await this.persistProjection(doc.id, edited.markdown);
    if (!persisted.ok) return persisted;
    return Ok({
      documentId: doc.id,
      markdown: edited.markdown,
      updateSeq: edited.updateSeq,
    });
  }

  async writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<{ documentId?: string }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) {
      return { ok: false, error: { code: "io_error", message: "Cannot write to source root" } };
    }
    const folderId = await this.ensureFolderId(dir);
    const { name, extension } = parseFilename(filename);
    const doc = await this.store.createBinaryDocument({
      folderId,
      name,
      extension,
      fileType: options.fileType,
      storageUrl: options.storageUrl,
      mimeType: options.mimeType,
      sizeBytes: options.sizeBytes,
    });
    return Ok({ documentId: doc.id });
  }

  async mkdir(path: string, _options?: ContextWriteOptions): Promise<Result<void, AdapterFault>> {
    const segments = path.split("/").filter(Boolean);
    // The source root always exists — empty `mkdir` is a no-op.
    if (segments.length === 0) return Ok(undefined);
    await this.ensureFolderId(segments);
    return Ok(undefined);
  }

  async list(path: string): Promise<Result<AdapterFileEntry[], AdapterFault>> {
    // Every segment of `path` is a folder name (no trailing filename to split).
    const folderId = await this.findFolderId(path.split("/").filter(Boolean));
    if (folderId === MISSING) return Ok([]);
    const membership = await this.resolveVisibleMembership();

    const [folders, documents] = await Promise.all([
      this.store.listFolders(folderId),
      this.listVisibleDocuments(folderId, membership),
    ]);

    const entries: AdapterFileEntry[] = folders.map((folder) => ({
      path: joinPath(path, folder.name),
      kind: "directory" as const,
    }));
    for (const doc of documents) {
      const trackedSchema =
        doc.fileType === null
          ? trackedSchemaForPersistedFiletype(doc.filetype ?? DEFAULT_EDITABLE_FILETYPE)
          : null;
      if (trackedSchema && !trackedSchema.ok) return trackedSchema;
      entries.push({
        path: joinPath(path, renderFilename(doc.name, doc.extension)),
        kind: "file",
        documentId: doc.id,
        sizeBytes: doc.sizeBytes ?? undefined,
        updatedAt: doc.updatedAt,
        provisionalName: doc.provisionalName,
        ...(doc.fileType === null
          ? {
              editable: true as const,
              filetype: doc.filetype ?? DEFAULT_EDITABLE_FILETYPE,
              schemaType: trackedSchema?.value ?? "document",
            }
          : {
              editable: false as const,
              fileType: doc.fileType,
              mimeType: doc.mimeType ?? undefined,
            }),
      });
    }
    return Ok(entries);
  }

  async search(
    query: string,
    pathPrefix?: string,
  ): Promise<Result<AdapterSearchHit[], AdapterFault>> {
    const prefix = pathPrefix?.replace(/\/+$/, "") ?? "";
    const membership = await this.resolveVisibleMembership();
    const documents = await this.collectDocuments("", null, membership);
    const hits: AdapterSearchHit[] = [];
    for (const row of documents) {
      if (prefix && row.path !== prefix && !row.path.startsWith(`${prefix}/`)) continue;
      if (row.document.fileType !== null) continue;
      const read = await this.searchableLines(row.document.id);
      if (!read.ok) return { ok: false, error: this.syncFault(read.error) };
      const match = firstLineMatch(read.value.join("\n"), query);
      if (!match) continue;
      hits.push({ path: row.path, excerpt: match.excerpt, line: match.line });
    }
    return Ok(hits);
  }

  private async collectDocuments(
    path: string,
    folderId: string | null,
    membership: Set<string> | null,
  ): Promise<Array<{ path: string; document: ContextDocument }>> {
    const out: Array<{ path: string; document: ContextDocument }> = [];
    for (const doc of await this.listVisibleDocuments(folderId, membership)) {
      out.push({ path: joinPath(path, renderFilename(doc.name, doc.extension)), document: doc });
    }
    for (const folder of await this.store.listFolders(folderId)) {
      out.push(
        ...(await this.collectDocuments(joinPath(path, folder.name), folder.id, membership)),
      );
    }
    return out;
  }

  private async readVisibleMarkdown(documentId: string): Promise<Result<string, SyncError>> {
    const effective = this.documentSync as MarkdownDocumentStore &
      Pick<BranchPeerShadowAccess, "readEffectiveMarkdown">;
    if (
      this.name === "manuscript" &&
      this.manifestView?.threadId &&
      effective.readEffectiveMarkdown
    ) {
      return effective.readEffectiveMarkdown({
        documentId: documentId as never,
        threadId: this.manifestView.threadId as never,
        responseId: this.manifestView.responseId,
      });
    }
    return this.documentSync.readAsMarkdown(documentId);
  }

  private async searchableLines(documentId: string): Promise<Result<string[], SyncError>> {
    const effective = this.documentSync as MarkdownDocumentStore &
      Pick<BranchPeerShadowAccess, "readEffectiveHashlines">;
    if (
      this.name === "manuscript" &&
      this.manifestView?.threadId &&
      effective.readEffectiveHashlines
    ) {
      return effective.readEffectiveHashlines({
        documentId: documentId as never,
        threadId: this.manifestView.threadId as never,
        responseId: this.manifestView.responseId,
      });
    }
    const read = await this.readVisibleMarkdown(documentId);
    return read.ok ? Ok(read.value.split("\n")) : read;
  }

  private async isVisibleDocument(documentId: string): Promise<boolean> {
    const membership = await this.resolveVisibleMembership();
    return !membership || membership.has(documentId);
  }

  private async resolveVisibleMembership(): Promise<Set<string> | null> {
    if (this.name !== "manuscript" || !this.manifestView) return null;
    const resolver = this.documentSync as MarkdownDocumentStore &
      Pick<BranchPeerShadowAccess, "resolveManifestMembership">;
    if (!resolver.resolveManifestMembership) return null;
    try {
      const membership = await resolver.resolveManifestMembership({
        projectId: this.manifestView.projectId as never,
        workId: this.manifestView.workId as never,
        threadId: this.manifestView.threadId as never,
        responseId: this.manifestView.responseId,
      });
      return membership.documentId ? new Set(membership.members) : null;
    } catch {
      // Fresh projects can race the tree route before manuscript context/manifest
      // seeding finishes; list without manifest filtering instead of surfacing 502.
      return null;
    }
  }

  private async listVisibleDocuments(
    folderId: string | null,
    membership: Set<string> | null,
  ): Promise<ContextDocument[]> {
    const rows = await this.store.listDocuments(folderId);
    if (!membership) return rows;
    return rows.filter((row) => membership.has(row.id));
  }

  private mutationFault(error: ContextTreeMutationError): AdapterFault {
    switch (error.code) {
      case "stale_source":
        return { code: "stale_source" };
      case "stale_target":
        return { code: "stale_target" };
      case "conflict":
        return { code: "conflict" };
      case "invalid_operation":
      case "not_found":
        return { code: "invalid_operation" };
    }
  }

  private async inspectMovable(
    path: string,
  ): Promise<Result<ContextLocationToken | null, AdapterFault>> {
    const sourceId = await this.store.contextSourceId();
    const token = await this.mutationStore.inspect(sourceId, path);
    if (token?.kind === "file" && !(await this.isVisibleDocument(token.nodeId))) return Ok(null);
    return Ok(token);
  }

  private async commitPreparedMove(
    prepared: PreparedContextMove,
  ): Promise<Result<AdapterMoveResult, AdapterFault>> {
    if (prepared.source.kind === "file") {
      const source = prepared.source;
      if (!(await this.isVisibleDocument(source.nodeId))) {
        return Err({ code: "invalid_operation" });
      }
      const destinationFiletype = moveFiletypeTransition(source, prepared.destinationPath);
      if (!destinationFiletype.ok) return destinationFiletype;
      const committed = await this.mutationStore.commitMove({
        source,
        destinationSourceId: prepared.destinationSourceId,
        destinationPath: prepared.destinationPath,
        expectedTarget: prepared.expectedTarget,
        overwrite: prepared.overwrite,
        graduateProvisionalName:
          "graduateProvisionalName" in prepared && prepared.graduateProvisionalName === true,
        destinationFiletype: destinationFiletype.value,
      });
      if (!committed.ok) return Err(this.mutationFault(committed.error));
      return Ok({
        movedNodeId: committed.value.movedNodeId,
        path: prepared.destinationPath,
      });
    }
    const source = prepared.source;
    const committed = await this.mutationStore.commitMove({
      source,
      destinationSourceId: prepared.destinationSourceId,
      destinationPath: prepared.destinationPath,
      expectedTarget: prepared.expectedTarget,
      overwrite: prepared.overwrite,
    });
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      movedNodeId: committed.value.movedNodeId,
      path: prepared.destinationPath,
    });
  }

  private async commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, AdapterFault>> {
    if (!(await this.isVisibleDocument(source.nodeId))) {
      return Err({ code: "invalid_operation" });
    }
    const committed = await this.mutationStore.commitProvisionalGraduation(source);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok(undefined);
  }

  private async commitPreparedDelete(
    token: ContextLocationToken,
  ): Promise<Result<AdapterDeleteResult, AdapterFault>> {
    if (token.kind === "file" && !(await this.isVisibleDocument(token.nodeId)))
      return Err({ code: "invalid_operation" });
    const committed = await this.mutationStore.commitDelete(token);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      deletedNodeId: committed.value.deletedNodeId,
    });
  }
}
