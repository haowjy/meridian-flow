/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`manuscript`/`kb`/`scratch`/`user`/`uploads`). It hides the document-store +
 * Yjs backing behind path-oriented filesystem operations; move/delete go through
 * the injected ContextTreeMutationStore for location CAS semantics.
 */

import { type CanonicalContextAuthority, canonicalContextUri } from "@meridian/contracts";
import {
  classifyFiletype,
  type Filetype,
  type ParsedDocumentFilename,
  parseDocumentFilename,
  type RetractionCause,
  storedFilename,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { compareCatalogSiblings } from "@meridian/resource-replica";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { isUuid } from "../../../../shared/uuid.js";
import type {
  BoundWrite,
  DocumentCreationAggregate,
  DocumentLinkScopes,
  DraftPeerShadowAccess,
  EffectiveReadVersion,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import { createDocumentCreationAggregate } from "../../../collab/index.js";
import { sourceDestination } from "../../../file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../../../projects/domain/work-lifecycle.js";
import { writeCollabMarkdown } from "../../context/collab-document-sync.js";
import { joinPath, renderFilename, splitPath } from "../../context/paths.js";
import {
  createResultAwareCommandExecutor,
  type ResultAwareCommandExecutor,
} from "../../context/result-aware-command-executor.js";
import type {
  AdapterCreatedFolder,
  AdapterDeleteResult,
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterGrepFile,
  AdapterGrepResult,
  AdapterMoveResult,
  ContextBranchTreeAdapter,
  ContextEnsureTrackedOptions,
  ContextSchemeAdapter,
  ContextTreeAdapter,
  SchemeCapabilities,
} from "../../ports/context-adapter.js";
import { schemeCapabilities } from "../../ports/context-adapter.js";
import type { ContextCommandTransaction } from "../../ports/context-command-transaction.js";
import type { ContextCopyAdapter } from "../../ports/context-copy.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
} from "../../ports/context-document-store.js";
import type {
  AdapterCreateFolderOptions,
  AdapterCreateUntitledOptions,
  ContextListOptions,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  GrepQuery,
  GrepShowing,
  ThreadContextView,
} from "../../ports/context-port.js";
import type {
  ContextLocationToken,
  ContextTreeDeleteCommand,
  ContextTreeMoveCommand,
  ContextTreeMutationError,
  ContextTreeMutationStore,
  PreparedContextMove,
} from "../../ports/context-tree-mutation-store.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { LineageScratchUnavailableError } from "../lineage-scratch-lifecycle.js";
import { BoundWrites, binaryTrackedWriteFault, DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { createContextFsCopyAdapter } from "./copy-adapter.js";
import {
  AMBIGUOUS_PATH_FAULT,
  type ContextPlacement,
  type CreatePlacement,
  createPlacement,
  OUTLIVED_PATH_FAULT,
} from "./create-placement.js";
import { resolveCreateTarget } from "./create-target.js";
import { fileRefOf, trackedSchemaForPersistedFiletype } from "./file-ref.js";
import { type GrepRead, scanDocuments } from "./grep-scan.js";
import { LiveCreate } from "./live-create.js";

/**
 * A document path's leaf through the name codec: its folders and canonical parts, null for
 * the source root, or the `invalid_name` fault a leaf that can't name a document is.
 */
function parseDocumentPath(
  path: string,
): Result<(ParsedDocumentFilename & { dir: string[] }) | null, AdapterFault> {
  const { dir, filename } = splitPath(path);
  if (!filename) return Ok(null);
  const parsed = parseDocumentFilename(filename);
  return parsed.ok ? Ok({ dir, ...parsed.value }) : Err(parsed.error);
}

export interface ContextFSDeps {
  /** Search spells its source's chapters from one snapshot; each read prepares its own. */
  links: Pick<DocumentLinkScopes, "within">;
  store: ContextDocumentStore;
  mutationStore: ContextTreeMutationStore;
  documentSync: MarkdownDocumentStore &
    Pick<
      DraftPeerShadowAccess,
      | "readEffectiveHashlines"
      | "readEffectiveMarkdown"
      | "readStoredGrepTexts"
      | "readStoredWordCounts"
    >;
  documentCreation?: DocumentCreationAggregate;
  commandTransaction?: ContextCommandTransaction;
  /** Scheme name used by the router for this filesystem instance. */
  scheme: ContextScheme;
  /**
   * The project a document created here belongs to, and the URI authority of
   * this source (a Work-scoped scheme's Work): content written into a new
   * document binds its links as that document's address (contract §6.2).
   */
  holder: { projectId: string; authority?: CanonicalContextAuthority };
  /** Where creates land and what reads see; the port factory decides it (`placementFor`). */
  placement: ContextPlacement;
  /** The thread reading through this adapter; without one, reads are live. */
  threadView?: ThreadContextView;
}

function moveFiletypeTransition(
  source: Pick<Extract<ContextLocationToken, { kind: "file" }>, "filetype" | "path">,
  destinationPath: string,
  destinationFiletype: Filetype | null,
): Result<Filetype | null, AdapterFault> {
  if (source.filetype === null) {
    if (destinationFiletype === null) return Ok(null);
    const destination = classifyFiletype(destinationFiletype);
    if (destination.kind !== "tracked") return Ok(null);
    return Err({
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename storage-backed file ${source.path} to ${destinationPath} because tracked documents require a Yjs schema`,
    });
  }

  const sourceSchema = trackedSchemaForPersistedFiletype(source.filetype);
  if (!sourceSchema.ok) return sourceSchema;
  const destination = classifyFiletype(destinationFiletype);
  if (destination.kind !== "tracked") {
    return Err({
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename tracked document ${source.path} to ${destinationPath} because binary and custom files use a different storage model`,
    });
  }
  if (destination.schemaType !== sourceSchema.value) {
    return Err({
      code: "invalid_operation",
      reason: "document_type_conversion",
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
 * Content is Yjs-canonical: the folder tree stays in the store, but read/write
 * content flows through the collab domain.
 *
 * Production commands lock the complete logical namespace before preflight.
 * Stores join that transaction; successful claims and tree changes publish
 * catalog metadata only after their location history has been reconciled.
 */
export class ContextFS implements ContextSchemeAdapter {
  readonly name: string;
  readonly capabilities: SchemeCapabilities;

  private readonly links: ContextFSDeps["links"];
  private readonly store: ContextDocumentStore;
  private readonly mutationStore: ContextTreeMutationStore;
  private readonly documentSync: ContextFSDeps["documentSync"];
  private readonly commandExecutor: ResultAwareCommandExecutor<AdapterFault>;
  private readonly placement: CreatePlacement;
  private readonly liveCreate: LiveCreate;
  private readonly readView?: ThreadContextView;
  private readonly scheme: ContextScheme;
  private readonly holder: ContextFSDeps["holder"];
  private readonly boundWrites: BoundWrites;

  readonly tree: ContextTreeAdapter = {
    inspectMovable: (path) => this.inspectMovable(path),
    inspectNode: async (node) => Ok(await this.mutationStore.inspectNode(node)),
    commitProvisionalGraduation: (source) => this.commitProvisionalGraduation(source),
    commitPreparedMove: (prepared) => this.commitPreparedMove(prepared),
    commitRecursiveDelete: (command) => this.commitRecursiveDelete(command),
  };
  readonly branchTree?: ContextBranchTreeAdapter;
  /** Copy's read and insert halves (`context/copy/` decides what to copy). */
  readonly copy: ContextCopyAdapter;

  constructor(deps: ContextFSDeps) {
    this.links = deps.links;
    this.capabilities = schemeCapabilities(deps.scheme);
    this.store = deps.store;
    this.mutationStore = deps.mutationStore;
    this.documentSync = deps.documentSync;
    const documentCreation =
      deps.documentCreation ??
      createDocumentCreationAggregate({
        atomic: (operation) => deps.store.transaction(operation),
      });
    this.commandExecutor = createResultAwareCommandExecutor({
      transaction: deps.commandTransaction ?? {
        run: (operation) => deps.store.transaction(() => operation({ branch: null })),
      },
      serializeThroughCallbacks: true,
      mapThrownError: (error) =>
        error instanceof LineageScratchUnavailableError
          ? { code: "not_found" }
          : error instanceof WorkLifecycleUnavailableError
            ? {
                code: "context_unavailable",
                reason: `work_${error.state}`,
                workHandle: error.workHandle ?? null,
              }
            : error instanceof ContextEntryConflictError
              ? {
                  code: "conflict",
                  ...(error.occupantKind ? { occupantKind: error.occupantKind } : {}),
                }
              : undefined,
    });
    this.readView = deps.threadView;
    this.scheme = deps.scheme;
    this.holder = deps.holder;
    this.name = deps.scheme;
    this.boundWrites = new BoundWrites({
      documentSync: deps.documentSync,
      commandExecutor: this.commandExecutor,
      projectId: deps.holder.projectId,
      holderUri: (path) => this.holderUri(path),
      findDocument: (path) => this.findDocumentAt(LIVE_TREE, path),
    });
    this.liveCreate = new LiveCreate({
      store: deps.store,
      executor: this.commandExecutor,
      documentSync: deps.documentSync,
      documentCreation,
      boundWrites: this.boundWrites,
      projectId: deps.holder.projectId,
      holderUri: (path) => this.holderUri(path),
      syncFault: (error) => this.syncFault(error),
    });
    this.placement = createPlacement(deps.placement, {
      store: deps.store,
      executor: this.commandExecutor,
      documentSync: deps.documentSync,
      liveCreate: this.liveCreate,
    });
    this.copy = createContextFsCopyAdapter({
      store: deps.store,
      documentCreation,
      documentSync: deps.documentSync,
      holderUri: (path) => this.holderUri(path),
      refuseReceive: () => this.placement.refuse("receive a copy"),
    });
    const branchTree = this.placement.branchTree;
    if (branchTree) {
      this.branchTree = {
        sourceId: () => this.store.contextSourceId(),
        // The destination's name as a move names it: an extensionless one keeps the source's
        // extension, and a rename never converts a document to another file type.
        move: async (path, command) => {
          const { dir, filename } = splitPath(path);
          // The stored extension, not the branch path's leaf: a kept `binary.md` and a document
          // `binary` share a leaf alias, and the row says which this is.
          const located = await this.store.findDocumentById(
            await this.readTreeView(),
            command.documentId as DocumentId,
          );
          if (!located) return Err({ code: "stale_source" });
          const ref = fileRefOf(located.document, located.path);
          if (!ref.ok) return ref;
          const from = {
            path: located.path,
            filetype: ref.value.kind === "tracked" ? ref.value.filetype : null,
            sourceId: await this.store.contextSourceId(),
          };
          const { extension: storedExtension } = located.document;
          const parsed = storedFilename(filename, { extension: storedExtension });
          if (!parsed.ok) return Err(parsed.error);
          // A storage-backed file keeps its type unless the extension changes.
          const transition = moveFiletypeTransition(
            from,
            path,
            from.filetype === null && parsed.filename.extension === storedExtension
              ? null
              : parsed.filename.filetype,
          );
          if (!transition.ok) return transition;
          const { name, extension } = parsed.filename;
          const moved = await branchTree.move(
            { dir, name, extension },
            {
              ...command,
              documentId: command.documentId as DocumentId,
              fromSourceId: from.sourceId,
            },
          );
          return moved.ok
            ? Ok({
                moved: moved.value.moved,
                path: [
                  ...dir,
                  renderFilename(moved.value.name ?? name, moved.value.extension ?? extension),
                ].join("/"),
              })
            : moved;
        },
        delete: (command) =>
          branchTree.delete({ ...command, documentId: command.documentId as DocumentId }),
      };
    }
  }

  private syncFault(error: SyncError): AdapterFault {
    switch (error.code) {
      case "not_found":
        return {
          code: "io_error",
          message: `Yjs document not found: ${error.documentId}`,
        };
      case "stale_generation":
        return { code: "io_error", message: `Document generation changed: ${error.documentId}` };
      case "checkpoint_not_found":
        return { code: "io_error", message: `Yjs checkpoint not found: ${error.checkpointId}` };
      case "corrupt_state":
        return { code: "io_error", message: error.message };
    }
  }

  /**
   * What reads see: a draft placement's Work's active branch, unless the thread asked for
   * the live text; live otherwise. Resolved once per command, never creating a branch.
   */
  private readTreeView(): Promise<TreeView> {
    return this.placement.readView(this.readView?.version);
  }

  /**
   * The document at `path` in `view` under its canonical name, or null. A path two of the
   * view's files share is the clash fault, never one of them.
   */
  private async findDocumentAt(
    view: TreeView,
    path: string,
  ): Promise<Result<ContextDocument | null, AdapterFault>> {
    const parsed = parseDocumentPath(path);
    if (!parsed.ok || !parsed.value) return Ok(null);
    const { dir, name, extension } = parsed.value;
    // A file kept under a prose suffix (`binary.md`) has that exact name; the codec would drop it.
    const exact = await this.store.resolveDocumentAt(view, path);
    const canonical = joinPath(dir.join("/"), renderFilename(name, extension));
    const found =
      exact.kind === "not_found" && canonical !== path
        ? await this.store.resolveDocumentAt(view, canonical)
        : exact;
    if (found.kind === "ambiguous")
      return Err(found.outlived ? OUTLIVED_PATH_FAULT : AMBIGUOUS_PATH_FAULT);
    return Ok(found.kind === "found" ? found.node : null);
  }

  /** A pending move keeps the live source address as an identity alias until Apply. */
  private async findAddressedDocument(
    view: TreeView,
    path: string,
  ): Promise<Result<ContextDocument | null, AdapterFault>> {
    const visible = await this.findDocumentAt(view, path);
    if (!visible.ok || visible.value || view.kind === "live") return visible;
    const physical = await this.findDocumentAt(LIVE_TREE, path);
    if (!physical.ok || !physical.value) return physical;
    return (await this.store.findDocumentById(view, physical.value.id)) ? physical : Ok(null);
  }

  async stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>> {
    const parsed = parseDocumentPath(path);
    if (!parsed.ok) return parsed;
    const view = await this.readTreeView();
    const found = await this.findAddressedDocument(view, path);
    if (!found.ok) return found;
    const doc = found.value;
    if (!doc || !parsed.value) return Ok(null);

    return fileRefOf(
      doc,
      joinPath(parsed.value.dir.join("/"), renderFilename(doc.name, doc.extension)),
    );
  }

  async read(
    path: string,
  ): Promise<Result<{ content: string; documentId?: string } | null, AdapterFault>> {
    const parsed = parseDocumentPath(path);
    if (!parsed.ok) return parsed;
    const view = await this.readTreeView();
    const found = await this.findAddressedDocument(view, path);
    if (!found.ok) return found;
    const doc = found.value;
    if (!doc) return Ok(null);
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
    const refused = this.placement.refuse("take a whole-file write");
    if (refused) return Err(refused);
    // An actor's overwrite keeps the refs of links it leaves in place; import and system writes bind fresh.
    const actor = options?.origin?.type === "agent" || options?.origin?.type === "human";
    const existing = await this.boundWrites.lookup(path);
    if (!existing.ok) return existing;
    // A whole-file write overwrites a document; it never creates one (creation is `create`).
    if (!existing.value) return Err({ code: "not_found" });
    const bound = await this.boundWrites.bind(
      path,
      existing.value,
      content,
      actor ? "current" : undefined,
    );
    if (!bound.ok) return bound;
    return this.commandExecutor.run(() => this.overwriteInTransaction(path, bound.value, options));
  }

  private holderUri(path: string): string {
    const { dir, filename } = splitPath(path);
    const parsed = parseDocumentFilename(filename);
    const canonicalPath = parsed.ok
      ? joinPath(dir.join("/"), renderFilename(parsed.value.name, parsed.value.extension))
      : path;
    return canonicalContextUri(this.scheme, canonicalPath, this.holder.authority);
  }

  private async overwriteInTransaction(
    path: string,
    content: BoundWrite,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId?: string }, AdapterFault>> {
    const found = await this.findDocumentAt(LIVE_TREE, path);
    if (!found.ok) return found;
    const existing = found.value;
    if (existing && existing.fileType !== null) return Err(binaryTrackedWriteFault(path));
    if (!existing || !this.boundWrites.boundFor(path, content, existing)) {
      return Err({ code: "stale_target" });
    }
    const write = await writeCollabMarkdown({
      documentSync: this.documentSync,
      documentId: existing.id,
      content,
      provenance: options?.origin,
    });
    if (!write.ok) return write;
    return Ok({
      documentId: existing.id,
      markdown: write.markdown,
      updateSeq: write.updateSeq,
    });
  }

  /**
   * Bind content for a document about to be created at `path`, before the
   * caller's transaction opens (an upload binds before finalizing).
   */
  async bindTrackedDocument(
    path: string,
    content: string,
  ): Promise<Result<BoundWrite, AdapterFault>> {
    return this.boundWrites.bind(path, null, content);
  }

  async createTrackedDocument(
    path: string,
    markdown: string,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const refused = this.placement.refuse("create a file with text");
    if (refused) return Err(refused);
    let bound: BoundWrite | null = null;
    if (markdown.length > 0) {
      const binding = await this.boundWrites.bind(path, null, markdown);
      if (!binding.ok) return binding;
      bound = binding.value;
    }
    return this.liveCreate.create(path, bound, options);
  }

  async createBoundDocument(
    path: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const refused = this.placement.refuse("create a file with text");
    if (refused) return Err(refused);
    if (bound && !this.boundWrites.boundFor(path, bound, null)) {
      return Err({ code: "io_error", message: `Content was bound for another document` });
    }
    return this.liveCreate.create(path, bound, options);
  }

  async locateDocument(documentId: string, options?: { includeDeleted?: boolean }) {
    const sourceId = await this.store.existingContextSourceId();
    if (!sourceId) return Ok(null);
    const located = await this.store.findDocumentById(await this.readTreeView(), documentId);
    if (!located && options?.includeDeleted) {
      const last = await this.store.findDocumentLastLocation(documentId);
      return last ? Ok({ documentId, path: last.path, name: last.name }) : Ok(null);
    }
    if (!located || located.contextSourceId !== sourceId) return Ok(null);
    return Ok({
      documentId: located.document.id,
      path: located.path,
      name: renderFilename(located.document.name, located.document.extension),
    });
  }

  async createUntitledDocument(
    path: string,
    options: AdapterCreateUntitledOptions,
  ): Promise<
    Result<
      {
        status: "created" | "already-exists" | "joined";
        documentId: string;
        path: string;
        name: string;
      },
      AdapterFault
    >
  > {
    const refused = this.placement.refuse("create an untitled file");
    if (refused) return Err(refused);
    if (!isUuid(options.documentId)) {
      return Err({ code: "invalid_operation", message: "documentId must be a UUID" });
    }
    const dir = path.split("/").filter(Boolean);
    let leaf: { name: string; extension: string; filetype: Filetype } | null = null;
    if (options.name !== undefined) {
      const target = resolveCreateTarget(joinPath(path, options.name));
      if (!target.ok) return target;
      leaf = target.value;
    }
    const created = await this.liveCreate.createOptimistic({
      dir,
      leaf,
      documentId: options.documentId as DocumentId,
      ...(options.expectFolderId ? { expectFolderId: options.expectFolderId } : {}),
      ...(options.position ? { position: options.position } : {}),
      options: { origin: options.origin },
    });
    if (!created.ok) return created;
    const { status, documentId, name } = created.value;
    // A replayed join knows only its target: the router reads that document's address.
    return Ok({
      status,
      documentId,
      path: created.value.path ?? (name ? joinPath(path, name) : ""),
      name: name ?? (created.value.path ?? "").split("/").at(-1) ?? "",
    });
  }

  ensureTrackedDocument(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<{ documentId: string; created: boolean }, AdapterFault>> {
    return this.placement.ensureTracked(path, options);
  }

  /**
   * Reverse this adapter's create of `documentId` for a rolled-back reply or a failed
   * create write (§12.5): a live create is deleted by the router; a branch's create ends
   * the branch's use unless another contribution makes it stand.
   */
  retractCreate(
    _path: string,
    documentId: string,
    cause: RetractionCause,
  ): Promise<Result<{ placement: "live" | "draft" }, AdapterFault>> {
    return this.placement.retract(documentId, cause);
  }

  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<{ documentId: string; placement: "live" | "draft" }, AdapterFault>> {
    return this.placement.writeBinary(path, options);
  }

  async createFolder(
    path: string,
    options: AdapterCreateFolderOptions,
  ): Promise<Result<AdapterCreatedFolder, AdapterFault>> {
    const refused = this.placement.refuse("make an empty folder");
    if (refused) return Err(refused);
    if (!isUuid(options.folderId)) {
      return Err({ code: "invalid_operation", message: "folderId must be a UUID" });
    }
    return this.commandExecutor.run(async () => {
      const parentId = await this.store.ensureFolderPath(path.split("/").filter(Boolean));
      if (options.expectFolderId !== undefined && parentId !== options.expectFolderId)
        return Err({ code: "stale_target" });
      const created = await this.store.createFolderIfAbsent({
        parentId,
        name: options.name,
        id: options.folderId,
        ...(options.position ? { position: options.position } : {}),
      });
      return Ok({
        status: created.status,
        folderId: created.folderId,
        path: created.path.join("/"),
        name: created.path.at(-1) ?? options.name,
      });
    });
  }

  async mkdir(path: string, _options?: ContextWriteOptions): Promise<Result<void, AdapterFault>> {
    const segments = path.split("/").filter(Boolean);
    // The source root always exists — empty `mkdir` is a no-op.
    if (segments.length === 0) return Ok(undefined);
    const refused = this.placement.refuse("make an empty folder");
    if (refused) return Err(refused);
    return this.commandExecutor.run(async () => {
      await this.store.ensureFolderPath(segments);
      return Ok(undefined);
    });
  }

  async list(
    path: string,
    options?: ContextListOptions,
  ): Promise<Result<AdapterFileEntry[], AdapterFault>> {
    const view = await this.readTreeView();
    // Every segment of `path` is a folder name (no trailing filename to split).
    const folder = await this.store.resolveFolderAt(view, path);
    if (folder.kind === "ambiguous") return Err(AMBIGUOUS_PATH_FAULT);
    if (folder.kind === "not_found") return Err({ code: "not_found" });
    const folderId = folder.node?.id ?? null;

    const [folders, documents] = await Promise.all([
      this.store.listFolders(view, folderId),
      this.store.listDocuments(view, folderId),
    ]);

    const wordCounts = options?.wordCounts
      ? await this.documentSync.readStoredWordCounts(
          documents.filter((doc) => doc.fileType === null).map((doc) => doc.id as DocumentId),
        )
      : new Map<string, number>();
    const orderPolicy = await this.store.parentOrderPolicy(view, folderId);
    const siblings = [
      ...folders.map((folder) => ({
        order: {
          kind: "folder" as const,
          name: folder.name,
          rank: folder.rank,
          entryId: folder.id,
        },
        folder,
      })),
      ...documents.map((document) => ({
        order: {
          kind: "file" as const,
          name: renderFilename(document.name, document.extension),
          rank: document.rank,
          entryId: document.id,
        },
        document,
      })),
    ].sort((left, right) =>
      compareCatalogSiblings(orderPolicy === "manual", left.order, right.order),
    );
    const entries: AdapterFileEntry[] = [];
    for (const sibling of siblings) {
      if ("folder" in sibling) {
        entries.push({
          path: joinPath(path, sibling.folder.name),
          kind: "directory",
          folderId: sibling.folder.id,
        });
        continue;
      }
      const doc = sibling.document;
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
              ...(wordCounts.has(doc.id as DocumentId)
                ? { wordCount: wordCounts.get(doc.id as DocumentId) }
                : {}),
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

  async grep(query: GrepQuery): Promise<Result<AdapterGrepResult, AdapterFault>> {
    const prefix = query.path?.replace(/\/+$/, "") ?? "";
    const { folders, documents } = await this.store.listTree(await this.readTreeView());
    const folderPaths = new Map<string | null, string | null>([[null, ""]]);
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    // Null for a folder whose chain to the root is incomplete (a deleted ancestor): its
    // documents are not candidates, rather than listed at the source root.
    const folderPath = (id: string | null): string | null => {
      const known = folderPaths.get(id);
      if (known !== undefined) return known;
      const folder = byId.get(id as string);
      const parent = folder ? folderPath(folder.parentId) : null;
      const path = folder && parent !== null ? joinPath(parent, folder.name) : null;
      folderPaths.set(id, path);
      return path;
    };
    const inScope = documents
      .flatMap((document) => {
        if (document.fileType !== null) return [];
        const folder = folderPath(document.folderId);
        if (folder === null) return [];
        const path = joinPath(folder, renderFilename(document.name, document.extension));
        const inPrefix = !prefix || path === prefix || path.startsWith(`${prefix}/`);
        return inPrefix && (!query.glob || query.glob(path)) ? [{ id: document.id, path }] : [];
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Access is decided before anything is matched or counted: neither the hits nor the total
    // may reveal a document the caller can't read.
    const access = await query.readable(inScope.map(({ id }) => id));
    const searchable = inScope.filter(({ id }) => access.has(id));
    const first = searchable[0];
    if (!first) return Ok({ files: [], totalFiles: 0, exact: true });

    const view = this.threadView();
    const stored = async (ids: string[]) => {
      const texts = await this.documentSync.readStoredGrepTexts({
        ...(view ?? { destination: "live" as const }),
        documentIds: ids as DocumentId[],
      });
      return new Map<string, string>(texts);
    };
    // One source has one project association, including personal and Work sources; its
    // chapters' reads join this snapshot, so it is read in their thread.
    return this.links.within(
      {
        documentId: first.id,
        documentIds: searchable.map(({ id }) => id),
        ...(view ? { viewer: { threadId: view.threadId } } : {}),
      },
      async () => {
        const scanned = await scanDocuments({
          documents: searchable,
          stored,
          matcher: query.matcher,
          mode: query.mode,
          headLimit: query.headLimit,
          signal: query.signal,
          read: async (documentId) => {
            const read = await this.readGrepBlocks(documentId);
            return read.ok ? read : { ok: false, error: this.syncFault(read.error) };
          },
        });
        if (!scanned.ok) return scanned;
        const { hits, totalFiles, exact, stopped } = scanned.value;
        const files = hits.map(
          ({ document, match, matchCount, revision, shown }): AdapterGrepFile => ({
            path: document.path,
            documentId: document.id,
            revision,
            readonly: access.get(document.id) !== "edit",
            matches: query.mode === "content" && match ? match.matches : [],
            ...(query.mode === "files_with_matches" ? {} : { matchCount }),
            ...(shown ? { shown } : {}),
          }),
        );
        return Ok({ files, totalFiles, exact, ...(stopped ? { stopped } : {}) });
      },
    );
  }

  /** The thread reading this source and the version it reads, or null outside a thread. */
  private threadView():
    | ({ threadId: ThreadId; responseId?: string | null } & EffectiveReadVersion)
    | null {
    const view = this.readView;
    if (!view) return null;
    const reader = { threadId: view.threadId as ThreadId, responseId: view.responseId };
    // Without a separate draft both versions are the same document (D3).
    const drafted = sourceDestination(this.scheme, view.branchWork).kind === "draft";
    return view.version !== "live" && drafted && view.branchWork
      ? { ...reader, destination: "draft", workId: view.branchWork.id as WorkId }
      : { ...reader, destination: "live" };
  }

  private async readVisibleMarkdown(documentId: string): Promise<Result<string, SyncError>> {
    const view = this.threadView();
    if (view) {
      const read = await this.documentSync.readEffectiveMarkdown({
        ...view,
        documentId: documentId as DocumentId,
      });
      return read.ok ? Ok(read.value.content) : read;
    }
    return this.documentSync.readAsMarkdown(documentId);
  }

  /**
   * A document's blocks as grep matches them, and the link facts each spells. Outside a thread
   * the live document is read, through the same reader.
   */
  private async readGrepBlocks(
    documentId: string,
  ): Promise<{ ok: true; value: GrepRead<GrepShowing> } | { ok: false; error: SyncError }> {
    const view = this.threadView() ?? { destination: "live" as const };
    const read = await this.documentSync.readEffectiveHashlines({
      ...view,
      documentId: documentId as DocumentId,
    });
    if (!read.ok) return read;
    const { blocks, holder, revision, locate } = read.value;
    return Ok({
      blocks,
      revision,
      locate,
      shownOf: ({ blocks: passageBlocks }) => {
        // Only the returned passages can be shown, never the matches past the cap.
        const passages = passageBlocks.map((block) => blocks[block]?.links ?? []);
        return holder.uri && passages.some((facts) => facts.length > 0)
          ? { holderUri: holder.uri, view: holder.view, passages }
          : undefined;
      },
    });
  }

  private mutationFault(error: ContextTreeMutationError): AdapterFault {
    switch (error.code) {
      case "destination_missing":
        return { code: "destination_missing" };
      case "stale_source":
        return { code: "stale_source" };
      case "stale_target":
        return { code: "stale_target" };
      case "conflict":
        return {
          code: "conflict",
          ...(error.occupantKind ? { occupantKind: error.occupantKind } : {}),
        };
      case "invalid_operation":
      case "not_found":
        return { code: "invalid_operation" };
    }
  }

  private async inspectMovable(
    path: string,
  ): Promise<Result<ContextLocationToken | null, AdapterFault>> {
    const sourceId = await this.store.contextSourceId();
    // The mover inspects the live tree: a hidden node is never moved or deleted live.
    return Ok(await this.mutationStore.inspect(sourceId, path));
  }

  private async commitPreparedMove(
    prepared: PreparedContextMove,
  ): Promise<Result<AdapterMoveResult, AdapterFault>> {
    let command: ContextTreeMoveCommand = prepared;
    if ("destinationFilename" in prepared) {
      const transition = moveFiletypeTransition(
        prepared.source,
        prepared.destinationPath,
        prepared.destinationFiletype,
      );
      if (!transition.ok) return transition;
      command = { ...prepared, destinationFiletype: transition.value };
    }
    const committed = await this.mutationStore.commitMove(command);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
      ...(committed.value.locationVersion
        ? { locationVersion: committed.value.locationVersion }
        : {}),
      path: committed.value.destinationPath,
    });
  }

  private async commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, AdapterFault>> {
    const committed = await this.mutationStore.commitProvisionalGraduation(source);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok(undefined);
  }

  private async commitRecursiveDelete(
    command: ContextTreeDeleteCommand,
  ): Promise<Result<AdapterDeleteResult, AdapterFault>> {
    const committed = await this.mutationStore.commitRecursiveDelete(command);
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      removed: committed.value.removed,
      availabilityGeneration: committed.value.availabilityGeneration,
    });
  }
}
