/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`manuscript`/`kb`/`scratch`/`user`/`uploads`). It hides the document-store +
 * Yjs backing behind path-oriented filesystem operations; move/delete go through
 * the injected ContextTreeMutationStore for location CAS semantics.
 */

import { splitHashline } from "@meridian/agent-edit";
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
import { countWords, createDocumentCreationAggregate } from "../../../collab/index.js";
import { sourceDestination } from "../../../file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../../../projects/domain/work-lifecycle.js";
import { writeCollabMarkdown } from "../../context/collab-document-sync.js";
import { joinPath, renderFilename, splitPath } from "../../context/paths.js";
import {
  createResultAwareCommandExecutor,
  type ResultAwareCommandExecutor,
} from "../../context/result-aware-command-executor.js";
import type { GrepBlock } from "../../grep/matcher.js";
import type {
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
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
} from "../../ports/context-document-store.js";
import type {
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
  ContextTreeMutationError,
  ContextTreeMutationStore,
  PreparedContextMove,
} from "../../ports/context-tree-mutation-store.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { LineageScratchUnavailableError } from "../lineage-scratch-lifecycle.js";
import { BoundWrites, binaryTrackedWriteFault, DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import {
  AMBIGUOUS_PATH_FAULT,
  type ContextPlacement,
  type CreatePlacement,
  createPlacement,
  OUTLIVED_PATH_FAULT,
} from "./create-placement.js";
import { resolveCreateTarget } from "./create-target.js";
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
      "readEffectiveHashlines" | "readEffectiveMarkdown" | "isStagedByResponse"
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

  async grep(query: GrepQuery): Promise<Result<AdapterGrepResult, AdapterFault>> {
    const prefix = query.path?.replace(/\/+$/, "") ?? "";
    const { folders, documents } = await this.store.listTree(await this.readTreeView());
    const folderPaths = new Map<string | null, string>([[null, ""]]);
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const folderPath = (id: string | null): string => {
      const known = folderPaths.get(id);
      if (known !== undefined) return known;
      const folder = byId.get(id as string);
      const path = folder ? joinPath(folderPath(folder.parentId), folder.name) : "";
      folderPaths.set(id, path);
      return path;
    };
    const inScope = documents
      .flatMap((document) => {
        if (document.fileType !== null) return [];
        const path = joinPath(
          folderPath(document.folderId),
          renderFilename(document.name, document.extension),
        );
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
    // Writes this reply staged to a live document stay in memory until it commits and leave no
    // draft row, so the stored text no longer describes what this reader sees.
    const stagedBy = view?.responseId;
    const stored = async (ids: string[]) => {
      const texts = await this.store.readGrepTexts(ids);
      if (stagedBy) {
        for (const id of ids) {
          if (this.documentSync.isStagedByResponse(stagedBy, id as DocumentId)) texts.delete(id);
        }
      }
      return texts;
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
          ...(query.signal ? { signal: query.signal } : {}),
          read: async (documentId) => {
            const read = await this.readGrepBlocks(documentId);
            return read.ok ? read : { ok: false, error: this.syncFault(read.error) };
          },
        });
        if (!scanned.ok) return scanned;
        const { hits, totalFiles, exact } = scanned.value;
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
        return Ok({ files, totalFiles, exact });
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
    const { content, destinationFree, links, holder, revision } = read.value;
    const blocks = content.map((entry, index): GrepBlock => {
      const parsed = splitHashline(entry);
      const body = parsed?.body ?? entry;
      return {
        body,
        destinationFree: destinationFree[index] ?? body,
        ...(parsed?.hash ? { hash: parsed.hash } : {}),
      };
    });
    return Ok({
      blocks,
      revision,
      shownOf: ({ blocks: passageBlocks }) => {
        // Only the returned passages can be shown, never the matches past the cap.
        const passages = passageBlocks.map((block) => links[block] ?? []);
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
        graduateProvisionalName:
          "graduateProvisionalName" in prepared && prepared.graduateProvisionalName === true,
        destinationFiletype: destinationFiletype.value,
      });
      if (!committed.ok) return Err(this.mutationFault(committed.error));
      return Ok({
        movedNodeId: committed.value.movedNodeId,
        ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
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
    });
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      movedNodeId: committed.value.movedNodeId,
      ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
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
