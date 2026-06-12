/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`fs1`/`kb`/`work`/`user`). It hides the document-store + Yjs backing behind
 * path-oriented filesystem operations, owning path resolution, folder
 * auto-creation, and write provenance at the ContextDocumentStore /
 * DocumentSyncPort boundary.
 */

import { filetypeForPath } from "@meridian/contracts/protocol";
import { Ok, type Result } from "../../../../shared/result.js";
import type {
  DocumentSyncPort,
  SyncError,
  UpdateOrigin,
} from "../../../collab/ports/document-sync.js";
import { joinPath, parseFilename, renderFilename, splitPath } from "../../context/paths.js";
import type {
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterSearchHit,
  ContextSchemeAdapter,
  SchemeCapabilities,
} from "../../ports/context-adapter.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type {
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  WriteProvenance,
} from "../../ports/context-port.js";

export interface ContextFSDeps {
  store: ContextDocumentStore;
  documentSync: DocumentSyncPort;
  /** Scheme name used by the router for this filesystem instance. */
  scheme: ContextScheme;
}

/** Folder-id of `null` is the source root; `MISSING` means the path is absent. */
const MISSING = Symbol("missing-folder");
const DEFAULT_EDITABLE_FILETYPE = "markdown";

/** Derive a non-null schema type from a string filetype. Only text filetypes
 *  reach this code path; unknown values default to `"code"`. */
function schemaTypeForStr(filetype: string): "document" | "code" {
  return filetype === "markdown" ? "document" : "code";
}

function toUpdateOrigin(provenance: WriteProvenance | undefined): UpdateOrigin {
  if (!provenance) return { type: "system" };
  switch (provenance.type) {
    case "agent":
      // Collab's update log still keys agent attribution by turn id.
      return { type: "agent", actorTurnId: provenance.turnId };
    case "human":
      return { type: "user", userId: provenance.userId };
    case "system":
      return { type: "system" };
  }
}

/**
 * Store-backed file tree for the `fs1://`, `kb://`, `work://`, and `user://` schemes.
 * Owns path ↔ folder-tree resolution and folder auto-creation; delegates
 * single-node persistence to a {@link ContextDocumentStore}.
 *
 * Content is Yjs-canonical: folder tree and `markdown_projection` stay in the
 * store, but read/write content flows through DocumentSyncService. The store's
 * markdown is only a seed/search projection cache.
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
  private readonly documentSync: DocumentSyncPort;

  constructor(deps: ContextFSDeps) {
    this.store = deps.store;
    this.documentSync = deps.documentSync;
    this.name = deps.scheme;
  }

  private syncFault(error: SyncError): AdapterFault {
    switch (error.code) {
      case "not_found":
        return {
          code: "io_error",
          message: `Yjs mirror not found for document: ${error.documentId}`,
        };
      case "checkpoint_not_found":
        return { code: "io_error", message: `Yjs checkpoint not found: ${error.checkpointId}` };
      case "corrupt_state":
        return { code: "io_error", message: error.message };
      case "edit_not_found":
        return { code: "io_error", message: `Edit text not found: ${error.oldText}` };
      case "ambiguous_edit":
        return {
          code: "io_error",
          message: `Edit text is ambiguous (${error.matchCount} matches): ${error.oldText}`,
        };
    }
  }

  private async getOrCreateMirror(
    docId: string,
    markdown: string,
    filetype: string,
  ): Promise<Result<void, AdapterFault>> {
    const mirror = await this.documentSync.getOrCreateMirror(docId, markdown, filetype);
    if (!mirror.ok) return { ok: false, error: this.syncFault(mirror.error) };
    return Ok(undefined);
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
        schemaType: schemaTypeForStr(filetype),
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

    const filetype = doc.filetype ?? DEFAULT_EDITABLE_FILETYPE;
    const mirror = await this.getOrCreateMirror(doc.id, doc.markdown, filetype);
    if (!mirror.ok) return mirror;

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

    const mirror = await this.getOrCreateMirror(doc.id, doc.markdown, doc.filetype ?? filetype);
    if (!mirror.ok) return mirror;

    const write = await this.documentSync.writeFromMarkdown(
      doc.id,
      content,
      toUpdateOrigin(options?.origin),
    );
    if (!write.ok) return { ok: false, error: this.syncFault(write.error) };

    const readBack = await this.documentSync.readAsMarkdown(doc.id);
    if (!readBack.ok) return { ok: false, error: this.syncFault(readBack.error) };
    const persisted = await this.store.upsertDocument({
      folderId,
      name,
      extension,
      markdown: readBack.value,
      filetype,
    });
    return Ok({ documentId: persisted.id });
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
              schemaType: schemaTypeForStr(doc.filetype ?? DEFAULT_EDITABLE_FILETYPE),
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
}
