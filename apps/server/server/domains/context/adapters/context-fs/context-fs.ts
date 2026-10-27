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
  filetypeForKnownPath,
  filetypeForPath,
  type NamespaceNameClaim,
  type ParsedDocumentFilename,
  parseDocumentFilename,
  type RetractionCause,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup/links";
import { compareCatalogSiblings } from "@meridian/resource-replica";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { isUuid } from "../../../../shared/uuid.js";
import type {
  BoundWrite,
  DocumentCreationAggregate,
  DocumentLinkScopes,
  DraftPeerShadowAccess,
  EffectiveReadVersion,
  HashlineRead,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import { countWords, createDocumentCreationAggregate } from "../../../collab/index.js";
import { sourceDestination } from "../../../file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../../../projects/domain/work-lifecycle.js";
import { writeCollabMarkdown } from "../../context/collab-document-sync.js";
import { joinPath, renderFilename, splitPath } from "../../context/paths.js";
import {
  createResultAwareCommandExecutor,
  type ResultAwareCommandExecutor,
} from "../../context/result-aware-command-executor.js";
import { documentMetadataFacts } from "../../document-metadata.js";
import type {
  AdapterCreatedFolder,
  AdapterDeleteResult,
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterMoveResult,
  AdapterSearchHit,
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
  ThreadContextView,
} from "../../ports/context-port.js";
import type {
  ContextLocationToken,
  ContextTreeDeleteCommand,
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
import { LiveCreate } from "./live-create.js";
import { matchDocument } from "./match.js";

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
    Pick<DraftPeerShadowAccess, "readEffectiveHashlines" | "readEffectiveMarkdown">;
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
  source: Pick<Extract<ContextLocationToken, { kind: "file" }>, "filetype" | "path">,
  destinationPath: string,
  parsedFiletype?: Filetype | null,
): Result<Filetype | null, AdapterFault> {
  if (source.filetype === null) {
    const knownDestinationFiletype =
      parsedFiletype === undefined ? filetypeForKnownPath(destinationPath) : parsedFiletype;
    if (knownDestinationFiletype === null) return Ok(null);
    const destination = classifyFiletype(knownDestinationFiletype);
    if (destination.kind !== "tracked") return Ok(null);
    return Err({
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename storage-backed file ${source.path} to ${destinationPath} because tracked documents require a Yjs schema`,
    });
  }

  const sourceSchema = trackedSchemaForPersistedFiletype(source.filetype);
  if (!sourceSchema.ok) return sourceSchema;
  const destinationFiletype = parsedFiletype ?? filetypeForPath(destinationPath);
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
 * Content is Yjs-canonical: folder tree and Markdown projections stay in the
 * store, but read/write content flows through the collab domain. The store's
 * markdown is only a search/listing projection cache.
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
        move: async (path, { from, ...command }) => {
          const { dir, filename } = splitPath(path);
          const current = parseDocumentFilename(splitPath(from.path).filename);
          const parsed = parseDocumentFilename(filename, {
            sourceExtension: current.ok ? current.value.extension : "",
          });
          if (!parsed.ok) return Err(parsed.error);
          const transition = moveFiletypeTransition(from, path, parsed.value.filetype);
          if (!transition.ok) return transition;
          const { name, extension } = parsed.value;
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
        delete: (_path, command) =>
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
    const found = await this.store.resolveDocumentAt(
      view,
      joinPath(dir.join("/"), renderFilename(name, extension)),
    );
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

    const base = {
      path: joinPath(parsed.value.dir.join("/"), renderFilename(doc.name, doc.extension)),
      documentId: doc.id,
      sizeBytes: doc.sizeBytes ?? undefined,
      updatedAt: doc.updatedAt,
      ...documentMetadataFacts(doc.metadata),
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

  async createTrackedDocumentAtFreeName(
    path: string,
    markdown: string,
    reserved: readonly NamespaceNameClaim[],
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; path: string }, AdapterFault>> {
    const refused = this.placement.refuse("create a file with text");
    if (refused) return Err(refused);
    return this.liveCreate.createAtFreeName(path, markdown, reserved, options);
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

    const projections = options?.wordCounts
      ? await this.store.readProjections(
          documents.filter((doc) => doc.fileType === null).map((doc) => doc.id),
        )
      : new Map<string, string>();
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
              ...(options?.wordCounts
                ? { wordCount: countWords(projections.get(doc.id) ?? "") }
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

  async search(
    query: string,
    pathPrefix?: string,
  ): Promise<Result<AdapterSearchHit[], AdapterFault>> {
    const prefix = pathPrefix?.replace(/\/+$/, "") ?? "";
    const documents = await this.collectDocuments(await this.readTreeView(), "", null);
    const searchable = documents.filter(
      ({ path, document }) =>
        document.fileType === null && (!prefix || path === prefix || path.startsWith(`${prefix}/`)),
    );
    const first = searchable[0];
    if (!first) return Ok([]);
    // One source has one project association, including personal and Work sources; its
    // chapters' reads join this snapshot, so it is read in their thread.
    const threadId = this.threadView()?.threadId;
    return this.links.within(
      {
        documentId: first.document.id,
        documentIds: searchable.map(({ document }) => document.id),
        ...(threadId ? { viewer: { threadId } } : {}),
      },
      async () => {
        const hits: AdapterSearchHit[] = [];
        for (const row of searchable) {
          const read = await this.searchableLines(row.document.id);
          if (!read.ok) return { ok: false, error: this.syncFault(read.error) };
          const found = matchDocument(read.value.entries, query, {
            hashlines: read.value.hashlines,
          });
          if (!found) continue;
          const { entries: passageEntries, ...match } = found;
          // Only the returned passages can be shown, never the matches past the cap.
          const passages = passageEntries.map((entry) => read.value.links[entry] ?? []);
          const { holder } = read.value;
          hits.push({
            path: row.path,
            documentId: row.document.id,
            revision: read.value.revision,
            ...match,
            ...(holder?.uri && passages.some((links) => links.length > 0)
              ? { shown: { holderUri: holder.uri, view: holder.view, passages } }
              : {}),
          });
        }
        return Ok(hits);
      },
    );
  }

  private async collectDocuments(
    view: TreeView,
    path: string,
    folderId: string | null,
  ): Promise<Array<{ path: string; document: ContextDocument }>> {
    const out: Array<{ path: string; document: ContextDocument }> = [];
    for (const doc of await this.store.listDocuments(view, folderId)) {
      out.push({ path: joinPath(path, renderFilename(doc.name, doc.extension)), document: doc });
    }
    for (const folder of await this.store.listFolders(view, folderId)) {
      out.push(...(await this.collectDocuments(view, joinPath(path, folder.name), folder.id)));
    }
    return out;
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
   * What a search scans, and whether its entries carry block hashes. Only the
   * thread view serializes hashlines, so the flag travels with the text
   * rather than being re-derived from the scheme name: a read outside a
   * thread view falls back to plain markdown and would otherwise be parsed as
   * hashlines it does not have.
   */
  private async searchableLines(documentId: string): Promise<
    Result<
      {
        entries: string[];
        hashlines: boolean;
        revision: string | null;
        links: readonly (readonly SpelledLinkFact[])[];
        holder?: HashlineRead["holder"];
      },
      SyncError
    >
  > {
    const view = this.threadView();
    if (view) {
      const hashlines = await this.documentSync.readEffectiveHashlines({
        ...view,
        documentId: documentId as DocumentId,
      });
      return hashlines.ok
        ? Ok({
            entries: hashlines.value.content,
            hashlines: true,
            revision: hashlines.value.revision,
            links: hashlines.value.links,
            holder: hashlines.value.holder,
          })
        : hashlines;
    }
    const read = await this.documentSync.readVersionedMarkdown(documentId);
    return read.ok
      ? Ok({
          entries: read.value.content.split("\n"),
          hashlines: false,
          revision: read.value.revision,
          // Plain lines are not blocks; outside a thread no model is shown anything.
          links: [],
        })
      : read;
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
    if (prepared.source.kind === "file") {
      // The mover found the source through its own adapter's inspectMovable,
      // which filters by that source's view in this transaction.
      const source = prepared.source;
      const destinationFiletype = moveFiletypeTransition(
        source,
        prepared.destinationPath,
        "destinationFiletype" in prepared ? prepared.destinationFiletype : undefined,
      );
      if (!destinationFiletype.ok) return destinationFiletype;
      const committed = await this.mutationStore.commitMove({
        source,
        linkNoteProjectId: prepared.linkNoteProjectId,
        actorUserId: prepared.actorUserId,
        destinationSourceId: prepared.destinationSourceId,
        destinationParentToken: prepared.destinationParentToken,
        destinationCreateFolders: prepared.destinationCreateFolders,
        destinationPath: prepared.destinationPath,
        expectedTarget: prepared.expectedTarget,
        overwrite: prepared.overwrite,
        position: prepared.position,
        graduateProvisionalName:
          "graduateProvisionalName" in prepared && prepared.graduateProvisionalName === true,
        destinationFiletype: destinationFiletype.value,
      });
      if (!committed.ok) return Err(this.mutationFault(committed.error));
      return Ok({
        movedNodeId: committed.value.movedNodeId,
        ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
        ...(committed.value.locationVersion
          ? { locationVersion: committed.value.locationVersion }
          : {}),
        path: committed.value.destinationPath,
      });
    }
    const source = prepared.source;
    const committed = await this.mutationStore.commitMove({
      source,
      linkNoteProjectId: prepared.linkNoteProjectId,
      actorUserId: prepared.actorUserId,
      destinationSourceId: prepared.destinationSourceId,
      destinationParentToken: prepared.destinationParentToken,
      destinationCreateFolders: prepared.destinationCreateFolders,
      destinationPath: prepared.destinationPath,
      expectedTarget: prepared.expectedTarget,
      overwrite: prepared.overwrite,
      position: prepared.position,
    });
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      movedNodeId: committed.value.movedNodeId,
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
