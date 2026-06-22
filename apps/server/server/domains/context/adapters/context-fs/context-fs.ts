/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`manuscript`/`kb`/`work`/`user`/`uploads`). It hides the document-store +
 * Yjs backing behind path-oriented filesystem operations; move/delete go through
 * the injected ContextTreeMutationStore for location CAS semantics.
 */

import { filetypeForPath, schemaTypeForFiletype } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { SyncError } from "../../../collab/index.js";
import {
  type ContextCollabDomain,
  editCollabMarkdown,
  writeCollabMarkdown,
} from "../../context/collab-document-sync.js";
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
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type {
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

export interface ContextFSDeps {
  store: ContextDocumentStore;
  mutationStore: ContextTreeMutationStore;
  documentSync: ContextCollabDomain;
  /** Scheme name used by the router for this filesystem instance. */
  scheme: ContextScheme;
}

/** Folder-id of `null` is the source root; `MISSING` means the path is absent. */
const MISSING = Symbol("missing-folder");
const DEFAULT_EDITABLE_FILETYPE = "markdown";

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
  private readonly documentSync: ContextCollabDomain;

  readonly tree: ContextTreeAdapter = {
    inspectMovable: (path) => this.inspectMovable(path),
    commitPreparedMove: (prepared) => this.commitPreparedMove(prepared),
    commitPreparedDelete: (token) => this.commitPreparedDelete(token),
  };

  constructor(deps: ContextFSDeps) {
    this.store = deps.store;
    this.mutationStore = deps.mutationStore;
    this.documentSync = deps.documentSync;
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

    const base = {
      path,
      documentId: doc.id,
      sizeBytes: doc.sizeBytes ?? undefined,
      updatedAt: doc.updatedAt,
    };
    if (doc.fileType === null) {
      const filetype = doc.filetype ?? DEFAULT_EDITABLE_FILETYPE;
      return Ok({
        ...base,
        kind: "tracked",
        filetype,
        schemaType: schemaTypeForFiletype(filetype) ?? "code",
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
    if (doc.fileType !== null) {
      return {
        ok: false,
        error: { code: "io_error", message: `Cannot read binary file as markdown: ${path}` },
      };
    }

    const read = await this.documentSync.readAsMarkdown(doc.id);
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
    const folderId = await this.ensureFolderId(dir);
    const { name, extension } = parseFilename(filename);
    const filetype = filetypeForPath(filename);
    const existing = await this.store.findDocument(folderId, name, extension);
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
    const persisted = await this.store.upsertDocument({
      folderId,
      name,
      extension,
      markdown: write.markdown,
      filetype,
    });
    return Ok({
      documentId: persisted.id,
      markdown: write.markdown,
      updateSeq: write.updateSeq,
    });
  }

  async edit(
    path: string,
    transform: (content: string) => string,
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

    const filetype = doc.filetype ?? DEFAULT_EDITABLE_FILETYPE;
    const edited = await editCollabMarkdown({
      documentSync: this.documentSync,
      documentId: doc.id,
      transform,
      provenance: options?.origin,
    });
    if (!edited.ok) return edited;

    const persisted = await this.store.upsertDocument({
      folderId,
      name,
      extension,
      markdown: edited.markdown,
      filetype,
    });
    return Ok({
      documentId: persisted.id,
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

    const [folders, documents] = await Promise.all([
      this.store.listFolders(folderId),
      this.store.listDocuments(folderId),
    ]);

    const entries: AdapterFileEntry[] = folders.map((folder) => ({
      path: joinPath(path, folder.name),
      kind: "directory" as const,
    }));
    for (const doc of documents) {
      entries.push({
        path: joinPath(path, renderFilename(doc.name, doc.extension)),
        kind: "file",
        documentId: doc.id,
        sizeBytes: doc.sizeBytes ?? undefined,
        updatedAt: doc.updatedAt,
        ...(doc.fileType === null
          ? {
              editable: true as const,
              filetype: doc.filetype ?? DEFAULT_EDITABLE_FILETYPE,
              schemaType:
                schemaTypeForFiletype(doc.filetype ?? DEFAULT_EDITABLE_FILETYPE) ?? "code",
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
    const rows = await this.store.searchDocuments(query);
    const prefix = pathPrefix?.replace(/\/+$/, "") ?? "";
    const hits: AdapterSearchHit[] = [];
    for (const row of rows) {
      const path = joinPath(
        row.folderPath,
        renderFilename(row.document.name, row.document.extension),
      );
      if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
      hits.push({ path, excerpt: row.excerpt, line: row.line });
    }
    return Ok(hits);
  }

  private mutationFault(error: ContextTreeMutationError): AdapterFault {
    switch (error.code) {
      case "stale_source":
      case "stale_target":
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
    return Ok(await this.mutationStore.inspect(sourceId, path));
  }

  private async commitPreparedMove(
    prepared: PreparedContextMove,
  ): Promise<Result<AdapterMoveResult & { invalidatedDocumentIds: string[] }, AdapterFault>> {
    const committed = await this.mutationStore.commitMove(prepared);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      movedNodeId: committed.value.movedNodeId,
      path: prepared.destinationPath,
      invalidatedDocumentIds: committed.value.invalidatedDocumentIds,
    });
  }

  private async commitPreparedDelete(
    token: ContextLocationToken,
  ): Promise<Result<AdapterDeleteResult & { invalidatedDocumentIds: string[] }, AdapterFault>> {
    const committed = await this.mutationStore.commitDelete(token);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      deletedNodeId: committed.value.deletedNodeId,
      invalidatedDocumentIds: committed.value.invalidatedDocumentIds,
    });
  }
}
