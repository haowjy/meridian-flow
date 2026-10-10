/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`manuscript`/`kb`/`scratch`/`user`/`uploads`). It hides the document-store +
 * Yjs backing behind path-oriented filesystem operations; move/delete go through
 * the injected ContextTreeMutationStore for location CAS semantics.
 */

import type { DraftId } from "@meridian/contracts";
import { type CanonicalContextAuthority, canonicalContextUri } from "@meridian/contracts";
import {
  classifyFiletype,
  type Filetype,
  filetypeForKnownPath,
  filetypeForPath,
  type YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup/links";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { isUuid } from "../../../../shared/uuid.js";
import type { Drafts } from "../../../collab/domain/drafts.js";
import type {
  BoundWrite,
  BranchPeerShadowAccess,
  DocumentCreationAggregate,
  DocumentLinkScopes,
  DocumentSeedOrigin,
  EffectiveReadVersion,
  HashlineRead,
  HeldLiveDocument,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import { countWords, createDocumentCreationAggregate } from "../../../collab/index.js";
import { sourceDestination } from "../../../file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../../../projects/domain/work-lifecycle.js";
import {
  writeCollabMarkdown,
  writeCollabMarkdownHeld,
} from "../../context/collab-document-sync.js";
import { joinPath, parseFilename, renderFilename, splitPath } from "../../context/paths.js";
import {
  createResultAwareCommandExecutor,
  type ResultAwareCommandExecutor,
} from "../../context/result-aware-command-executor.js";
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
import { schemeCapabilities } from "../../ports/context-adapter.js";
import type {
  ContextCommandDraft,
  ContextCommandTransaction,
} from "../../ports/context-command-transaction.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
  LiveCreateCandidateChangedError,
  type LiveCreateExpectation,
} from "../../ports/context-document-store.js";
import type {
  ContextCreateUntitledDocumentOptions,
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
import type { CreateFault } from "../../tree/hidden-nodes.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { LineageScratchUnavailableError } from "../lineage-scratch-lifecycle.js";
import {
  BoundWrites,
  binaryTrackedWriteFault,
  DEFAULT_EDITABLE_FILETYPE,
  trackedFiletypeForPath,
} from "./bound-writes.js";
import { matchDocument } from "./match.js";

/**
 * Where this adapter's creates land and what its reads see (contract §2.3). People and
 * auto-apply Works are live. A draft-mode Work's thread on a drafted source is a draft
 * placement: reads see the Work's active draft (live while it has none), and creates make
 * hidden rows in that draft, which the command transaction ensures.
 */
export type ContextPlacement =
  | { kind: "live" }
  | {
      kind: "draft";
      workId: string;
      projectId: string;
      threadId: string;
      userId: string;
      drafts: Pick<Drafts, "viewForWork">;
    };

export interface ContextFSDeps {
  /** Search spells its source's chapters from one snapshot; each read prepares its own. */
  links: Pick<DocumentLinkScopes, "within">;
  store: ContextDocumentStore;
  mutationStore: ContextTreeMutationStore;
  documentSync: MarkdownDocumentStore &
    Pick<
      BranchPeerShadowAccess,
      "readEffectiveHashlines" | "readEffectiveMarkdown" | "ensureCreatedDraftBranch"
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
  placement?: ContextPlacement;
  /** The thread reading through this adapter; without one, reads are live. */
  threadView?: ThreadContextView;
}

class DocumentCreationFault extends Error {
  constructor(readonly fault: AdapterFault) {
    super("message" in fault ? fault.message : fault.code);
  }
}

/** Folder-id of `null` is the source root; `MISSING` means the path is absent. */
const MISSING = Symbol("missing-folder");
const UNTITLED_NAME_PATTERN = /^Untitled (\d+)$/;
const UNTITLED_ALLOCATION_ATTEMPTS = 32;

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
  private readonly documentCreation: DocumentCreationAggregate;
  private readonly commandExecutor: ResultAwareCommandExecutor<AdapterFault>;
  private readonly placement: ContextPlacement;
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

  constructor(deps: ContextFSDeps) {
    this.links = deps.links;
    this.capabilities = schemeCapabilities(deps.scheme);
    this.store = deps.store;
    this.mutationStore = deps.mutationStore;
    this.documentSync = deps.documentSync;
    this.documentCreation =
      deps.documentCreation ??
      createDocumentCreationAggregate({
        atomic: (operation) => deps.store.transaction(operation),
        ensureDocument: (documentId) => deps.documentSync.ensureDocument(documentId),
      });
    this.commandExecutor = createResultAwareCommandExecutor({
      transaction: deps.commandTransaction ?? {
        run: (operation) => deps.store.transaction(() => operation({ draft: null })),
      },
      serializeThroughCallbacks: true,
      mapThrownError: (error) =>
        error instanceof LineageScratchUnavailableError
          ? { code: "not_found" }
          : error instanceof WorkLifecycleUnavailableError
            ? {
                code: "context_unavailable",
                reason: `work_${error.state}`,
                workSlug: error.workSlug ?? null,
              }
            : error instanceof ContextEntryConflictError
              ? { code: "conflict" }
            : undefined,
    });
    this.placement = deps.placement ?? { kind: "live" };
    this.readView = deps.threadView;
    this.scheme = deps.scheme;
    this.holder = deps.holder;
    this.name = deps.scheme;
    this.boundWrites = new BoundWrites({
      documentSync: deps.documentSync,
      commandExecutor: this.commandExecutor,
      projectId: deps.holder.projectId,
      holderUri: (path) => this.holderUri(path),
      findDocument: async (path) => {
        const { dir, filename } = splitPath(path);
        if (!filename) return null;
        const folderId = await this.findFolderId(LIVE_TREE, dir);
        if (folderId === MISSING) return null;
        const { name, extension } = parseFilename(filename);
        return this.store.findDocument(LIVE_TREE, folderId, name, extension);
      },
    });
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
   * What reads see: a draft placement's Work's active draft, unless the thread asked for
   * the live text; live otherwise. Resolved once per command, never creating a draft.
   */
  private async readTreeView(): Promise<TreeView> {
    if (this.placement.kind === "live" || this.readView?.version === "live") return LIVE_TREE;
    return this.placement.drafts.viewForWork(this.placement.workId as WorkId);
  }

  /** The command transaction a draft's create runs in: it locks the Work and ensures the draft. */
  private draftCommand(mode: ContextCommandDraft["mode"]): ContextCommandDraft | null {
    if (this.placement.kind !== "draft") return null;
    return {
      mode,
      workId: this.placement.workId,
      threadId: this.placement.threadId,
      userId: this.placement.userId,
    };
  }

  private draftOnlyFault(operation: string): AdapterFault {
    return {
      code: "invalid_operation",
      message: `A draft can't ${operation}; create the file empty and write into it`,
    };
  }

  private createFault(fault: CreateFault): AdapterFault {
    return fault.code === "ambiguous"
      ? {
          code: "invalid_operation",
          message:
            "More than one file has this path in the draft; review the draft to resolve the clash",
        }
      : { code: "conflict" };
  }

  private async createTrackedDocumentAtomically(input: {
    id?: string;
    folderId: string | null;
    name: string;
    extension: string;
    filetype: Filetype;
    /** Bound before the command transaction; null creates an empty document. */
    content: BoundWrite | null;
    provisionalName?: boolean;
    options?: ContextWriteOptions;
    /** What the create must still find under its locks (§6.3), and the lease it holds. */
    live?: LiveCreateExpectation & { held?: HeldLiveDocument; uri?: string };
  }): Promise<Result<{ document: ContextDocument; markdown: string }, AdapterFault>> {
    const documentId = input.live?.revealById ?? input.id ?? crypto.randomUUID();
    let document: ContextDocument | null = null;
    let revealed = false;
    try {
      const created = await this.documentCreation.createDocumentAtomically({
        persistIdentity: async () => {
          const claimed = await this.store.createDocumentRecordIfAbsent({
            id: documentId,
            folderId: input.folderId,
            name: input.name,
            extension: input.extension,
            markdown: "",
            filetype: input.filetype,
            provisionalName: input.provisionalName,
            ...(input.options?.metadata ? { metadata: input.options.metadata } : {}),
            ...(input.live?.expected ? { expected: input.live.expected } : {}),
            ...(input.live?.revealById ? { revealById: input.live.revealById } : {}),
          });
          document = claimed?.document ?? null;
          revealed = claimed?.revealed ?? false;
          return (claimed?.document.id ?? null) as DocumentId | null;
        },
        initializeContent: async (claimedId) => {
          if (input.content === null || input.content.markdown.length === 0) {
            // A revealed document's live Yjs is already empty: a draft never seeds it.
            await this.documentCreation.ensureDocument(claimedId);
            return "";
          }
          if (revealed) {
            // A revealed document already has a live identity others may hold: its first
            // content is admitted only under the lease the caller took before the
            // transaction (§6.3, B3).
            const held = input.live?.held;
            if (!held || held.documentId !== claimedId || !input.live?.uri) {
              throw new LiveCreateCandidateChangedError();
            }
            const written = await writeCollabMarkdownHeld({
              documentSync: this.documentSync,
              held,
              content: input.content,
              expected: { documentId: claimedId as DocumentId, uri: input.live.uri },
              provenance: input.options?.origin,
            });
            if (!written.ok) throw new DocumentCreationFault(written.error);
            return written.markdown;
          }
          const provenance = input.options?.origin;
          const origin: DocumentSeedOrigin =
            provenance?.type === "import"
              ? {
                  type: "import",
                  userId: provenance.userId,
                  source: provenance.source,
                  filename: provenance.filename,
                  sourceId: provenance.sourceId,
                }
              : { type: "system" };
          const seeded = await this.documentSync.seedFromMarkdown(claimedId, input.content, origin);
          if (!seeded.ok) {
            throw new DocumentCreationFault(this.syncFault(seeded.error));
          }
          return input.content.markdown;
        },
      });
      if (!created.created) return Err({ code: "conflict" });
      if (!document) {
        return Err({ code: "io_error", message: "Created document identity was not returned" });
      }
      return Ok({ document, markdown: created.value });
    } catch (error) {
      if (error instanceof DocumentCreationFault) return Err(error.fault);
      throw error;
    }
  }

  /** Resolve a folder chain in a view without creating; `MISSING` if any segment is absent. */
  private async findFolderId(
    view: TreeView,
    dir: string[],
  ): Promise<string | null | typeof MISSING> {
    let parentId: string | null = null;
    for (const name of dir) {
      const existing = await this.store.findFolder(view, parentId, name);
      if (!existing) return MISSING;
      parentId = existing.id;
    }
    return parentId;
  }

  /** The document at `path` in `view`, or null. */
  private async findDocumentAt(view: TreeView, path: string): Promise<ContextDocument | null> {
    const { dir, filename } = splitPath(path);
    if (!filename) return null;
    const folderId = await this.findFolderId(view, dir);
    if (folderId === MISSING) return null;
    const { name, extension } = parseFilename(filename);
    return this.store.findDocument(view, folderId, name, extension);
  }

  async stat(path: string): Promise<Result<AdapterFileRef | null, AdapterFault>> {
    const doc = await this.findDocumentAt(await this.readTreeView(), path);
    if (!doc) return Ok(null);

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
    const doc = await this.findDocumentAt(await this.readTreeView(), path);
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
    if (this.placement.kind === "draft") return Err(this.draftOnlyFault("take a whole-file write"));
    // An actor's overwrite keeps the refs of links it leaves in place; import and system writes bind fresh.
    const actor = options?.origin?.type === "agent" || options?.origin?.type === "human";
    const existing = await this.boundWrites.lookup(path);
    if (!existing.ok) return existing;
    const bound = await this.boundWrites.bind(
      path,
      existing.value,
      content,
      actor ? "current" : undefined,
    );
    if (!bound.ok) return bound;
    if (!existing.value) return this.createLiveDocument(path, bound.value, options);
    return this.commandExecutor.run(() => this.overwriteInTransaction(path, bound.value, options));
  }

  private holderUri(path: string): string {
    return canonicalContextUri(this.scheme, path, this.holder.authority);
  }

  private async overwriteInTransaction(
    path: string,
    content: BoundWrite,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId?: string }, AdapterFault>> {
    const existing = await this.findDocumentAt(LIVE_TREE, path);
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
    if (this.placement.kind === "draft") return Err(this.draftOnlyFault("create a file with text"));
    let bound: BoundWrite | null = null;
    if (markdown.length > 0) {
      const binding = await this.boundWrites.bind(path, null, markdown);
      if (!binding.ok) return binding;
      bound = binding.value;
    }
    return this.createLiveDocument(path, bound, options);
  }

  async createBoundDocument(
    path: string,
    bound: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    if (this.placement.kind === "draft") return Err(this.draftOnlyFault("create a file with text"));
    if (bound && !this.boundWrites.boundFor(path, bound, null)) {
      return Err({ code: "io_error", message: `Content was bound for another document` });
    }
    return this.createLiveDocument(path, bound, options);
  }

  /**
   * A live create at `path` (§6.3, §6.4). It reveals a hidden document at the path (or
   * the one `options.documentId` names) instead of inserting a twin. With content, the
   * candidate is discovered holding nothing, its live lease taken, and only then the
   * command transaction opens and revalidates it; a changed candidate rolls back and
   * rediscovers once, then is a conflict.
   */
  private async createLiveDocument(
    path: string,
    content: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
    const withContent = content !== null && content.markdown.length > 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const discovered = await this.commandExecutor.exclusive(() =>
        this.discoverLiveCreate(path, dir, filename, options),
      );
      if ("fault" in discovered) return Err(discovered.fault);
      if ("existing" in discovered) return Ok({ documentId: discovered.existing });
      const run = (held?: HeldLiveDocument) =>
        this.commandExecutor.run(
          () =>
            this.createTrackedDocumentInTransaction(path, content, options, {
              ...discovered.live,
              ...(held ? { held, uri: this.holderUri(path) } : {}),
            }),
          undefined,
          discovered.sourceId ? { sourceIds: [discovered.sourceId] } : undefined,
        );
      try {
        return withContent && discovered.candidate
          ? await this.documentSync.withLiveDocument(discovered.candidate, run)
          : await run();
      } catch (error) {
        if (!(error instanceof LiveCreateCandidateChangedError)) throw error;
      }
    }
    return Err({ code: "conflict" });
  }

  /** §6.3 step 1 and §6.4's discovery, holding nothing. */
  private async discoverLiveCreate(
    path: string,
    dir: string[],
    filename: string,
    options?: ContextWriteOptions,
  ): Promise<
    | { fault: AdapterFault }
    | { existing: string }
    | {
        live: LiveCreateExpectation;
        candidate?: string;
        /** The candidate's current source, locked with the destination's. */
        sourceId?: string;
      }
  > {
    const requestedId = options?.documentId;
    if (requestedId) {
      const identity = await this.store.liveIdentity(requestedId);
      if (identity.kind === "visible") {
        const at = await this.findDocumentAt(LIVE_TREE, path);
        return at?.id === requestedId ? { existing: requestedId } : { fault: { code: "conflict" } };
      }
      if (identity.kind === "hidden") {
        return {
          live: {
            revealById: requestedId,
            expected: { documentId: requestedId, sourceId: identity.contextSourceId },
          },
          candidate: requestedId,
          sourceId: identity.contextSourceId,
        };
      }
      return { live: {} };
    }
    const found = await this.store.findLiveCreateCandidate(dir, filename);
    if ("occupant" in found) return { fault: { code: "conflict" } };
    if ("none" in found) return { live: { expected: { none: true } } };
    return {
      live: { expected: { documentId: found.candidate, sourceId: found.sourceId } },
      candidate: found.candidate,
      sourceId: found.sourceId,
    };
  }

  private async createTrackedDocumentInTransaction(
    path: string,
    content: BoundWrite | null,
    options: ContextWriteOptions | undefined,
    live: LiveCreateExpectation & { held?: HeldLiveDocument; uri?: string },
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
    const resolvedFiletype = trackedFiletypeForPath(filename);
    if (!resolvedFiletype.ok) return resolvedFiletype;
    const filetype = resolvedFiletype.value;
    const folderId = await this.store.ensureFolderPath(dir);
    const { name, extension } = parseFilename(filename);
    const existing = await this.store.findDocument(LIVE_TREE, folderId, name, extension);
    if (existing) {
      if (existing.fileType !== null) return Err(binaryTrackedWriteFault(path));
      return Err({ code: "conflict" });
    }
    if (content && !this.boundWrites.boundFor(path, content, null)) {
      return Err({ code: "stale_target" });
    }
    const created = await this.createTrackedDocumentAtomically({
      id: options?.documentId,
      folderId,
      name,
      extension,
      filetype,
      content,
      options,
      live,
    });
    return created.ok ? Ok({ documentId: created.value.document.id }) : created;
  }

  async locateDocument(documentId: string) {
    const sourceId = await this.store.existingContextSourceId();
    if (!sourceId) return Ok(null);
    const located = await this.store.findDocumentById(await this.readTreeView(), documentId);
    if (!located || located.contextSourceId !== sourceId) return Ok(null);
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
    if (this.placement.kind === "draft") return Err(this.draftOnlyFault("create an untitled file"));
    if (!isUuid(options.documentId)) {
      return Err({ code: "invalid_operation", message: "documentId must be a UUID" });
    }
    const identity = await this.commandExecutor.exclusive(() =>
      this.store.liveIdentity(options.documentId),
    );
    return this.commandExecutor.run(
      () => this.createUntitledDocumentInTransaction(path, options, identity),
      undefined,
      identity.kind === "hidden" ? { sourceIds: [identity.contextSourceId] } : undefined,
    );
  }

  private async createUntitledDocumentInTransaction(
    path: string,
    options: ContextCreateUntitledDocumentOptions,
    identity: Awaited<ReturnType<ContextDocumentStore["liveIdentity"]>>,
  ): Promise<
    Result<
      { status: "created" | "already-exists"; documentId: string; path: string; name: string },
      AdapterFault
    >
  > {
    const sourceId = await this.store.contextSourceId();
    const alreadyExists = async () => {
      const existing = await this.store.findDocumentById(LIVE_TREE, options.documentId);
      if (!existing || existing.contextSourceId !== sourceId) return null;
      return Ok({
        status: "already-exists" as const,
        documentId: existing.document.id,
        path: existing.path,
        name: renderFilename(existing.document.name, existing.document.extension),
      });
    };
    if (identity.kind === "visible") return (await alreadyExists()) ?? Err({ code: "conflict" });

    const folderSegments = path.split("/").filter(Boolean);
    const folderId = await this.store.ensureFolderPath(folderSegments);
    for (let attempt = 0; attempt < UNTITLED_ALLOCATION_ATTEMPTS; attempt += 1) {
      const documents = await this.store.listDocuments(LIVE_TREE, folderId);
      const maxNumber = documents.reduce((max, document) => {
        const match = UNTITLED_NAME_PATTERN.exec(document.name);
        if (!match) return max;
        const suffix = Number(match[1]);
        return Number.isSafeInteger(suffix) && suffix < Number.MAX_SAFE_INTEGER
          ? Math.max(max, suffix)
          : max;
      }, 0);
      const name = `Untitled ${maxNumber + 1}`;
      const created = await this.createTrackedDocumentAtomically({
        id: options.documentId,
        folderId,
        name,
        extension: "md",
        filetype: "markdown",
        content: null,
        provisionalName: true,
        options: { origin: options.origin },
        // A hidden id is a draft's document: the untitled create reveals it (§5.2, §6.4).
        ...(identity.kind === "hidden"
          ? {
              live: {
                revealById: options.documentId,
                expected: { documentId: options.documentId, sourceId: identity.contextSourceId },
              },
            }
          : {}),
      });
      if (created.ok) {
        const document = created.value.document;
        return Ok({
          status: "created",
          documentId: document.id,
          path: joinPath(path, renderFilename(document.name, document.extension)),
          name: renderFilename(document.name, document.extension),
        });
      } else if (created.error.code !== "conflict") return created;

      const collision = await alreadyExists();
      if (collision) return collision;
      if ((await this.store.liveIdentity(options.documentId)).kind !== "other") {
        return Err({ code: "conflict" });
      }
    }
    return Err({ code: "conflict" });
  }

  async ensureTrackedDocument(
    path: string,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; created: boolean }, AdapterFault>> {
    const draft = this.draftCommand("ensure");
    if (draft) {
      return this.commandExecutor.run(
        ({ draft: ensured }) => this.ensureInDraft(path, ensured, options),
        undefined,
        { draft },
      );
    }
    return this.commandExecutor.run(() => this.ensureTrackedDocumentInTransaction(path, options));
  }

  /** A model's create in a draft-mode Work (§6.2): a hidden row in the draft, empty. */
  private async ensureInDraft(
    path: string,
    draft: { id: DraftId; originWorkId: WorkId | null } | null,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; created: boolean }, AdapterFault>> {
    if (!draft) throw new Error("A draft create ran without its draft");
    const { dir, filename } = splitPath(path);
    if (!filename) return Err({ code: "io_error", message: "Cannot create source root" });
    const resolvedFiletype = trackedFiletypeForPath(filename);
    if (!resolvedFiletype.ok) return resolvedFiletype;
    const { name, extension } = parseFilename(filename);
    const workId = this.placement.kind === "draft" ? this.placement.workId : null;
    if (!workId) throw new Error("A draft create needs a draft placement");
    const created = await this.store.createInDraft({
      draftId: draft.id,
      dir,
      name,
      extension,
      node: {
        kind: "tracked",
        filetype: resolvedFiletype.value,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      },
      ensureEmptyContent: (documentId) => this.documentSync.ensureDocument(documentId),
      ensureDraftBranch: (documentId) =>
        this.documentSync.ensureCreatedDraftBranch({ documentId, workId: workId as WorkId }),
    });
    if (!created.ok) return Err(this.createFault(created.error));
    if (created.value.kind === "existing") {
      if (created.value.binary) return Err(binaryTrackedWriteFault(path));
      await this.documentSync.ensureDocument(created.value.documentId);
      return Ok({ documentId: created.value.documentId, created: false });
    }
    return Ok({ documentId: created.value.documentId, created: true });
  }

  private async ensureTrackedDocumentInTransaction(
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
    const folderId = await this.store.ensureFolderPath(dir);
    const { name, extension } = parseFilename(filename);
    const existing = await this.store.findDocument(LIVE_TREE, folderId, name, extension);
    if (existing && existing.fileType !== null) {
      return Err(binaryTrackedWriteFault(path));
    }
    if (existing) {
      await this.documentSync.ensureDocument(existing.id);
      return Ok({ documentId: existing.id, created: false });
    }

    // Empty: a hidden document at the path is revealed with no lease (§6.3 step 3).
    const created = await this.createTrackedDocumentAtomically({
      folderId,
      name,
      extension,
      filetype,
      content: null,
      options,
    });
    return created.ok ? Ok({ documentId: created.value.document.id, created: true }) : created;
  }

  /**
   * Reverse this adapter's create of `documentId` at `path` for a rolled-back reply or a
   * failed create write (§12.5). A live create is deleted; a draft's create ends the
   * draft's use of the document, unless the draft's branch on it already holds committed
   * text from another thread or reply, in which case it stands.
   */
  async retractCreate(
    _path: string,
    documentId: string,
  ): Promise<Result<{ placement: "live" | "draft" }, AdapterFault>> {
    const draft = this.draftCommand("existing");
    // A live create is reversed by deleting it; the router does that.
    if (!draft) return Ok({ placement: "live" });
    return this.commandExecutor.run(
      async ({ draft: active }) => {
        // No active draft: a whole Discard already ended every use.
        if (active) {
          await this.store.retractDraftCreate({
            draftId: active.id,
            workId: draft.workId,
            documentId: documentId as DocumentId,
          });
        }
        return Ok({ placement: "draft" as const });
      },
      undefined,
      { draft },
    );
  }

  async writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<{ documentId?: string }, AdapterFault>> {
    const { dir, filename } = splitPath(path);
    if (!filename) {
      return { ok: false, error: { code: "io_error", message: "Cannot write to source root" } };
    }
    const { name, extension } = parseFilename(filename);
    const draft = this.draftCommand("ensure");
    if (draft) {
      // A draft's binary is its own hidden row holding the draft's object (12b-Q2).
      return this.commandExecutor.run(
        async ({ draft: ensured }) => {
          if (!ensured) throw new Error("A draft create ran without its draft");
          const created = await this.store.createInDraft({
            draftId: ensured.id,
            dir,
            name,
            extension,
            node: {
              kind: "binary",
              ...(options.documentId ? { documentId: options.documentId as DocumentId } : {}),
              fileType: options.fileType,
              storageUrl: options.storageUrl,
              mimeType: options.mimeType,
              sizeBytes: options.sizeBytes,
              ...(options.metadata ? { metadata: options.metadata } : {}),
            },
            ensureEmptyContent: async () => {},
            ensureDraftBranch: async () => {},
          });
          if (!created.ok) return Err(this.createFault(created.error));
          return Ok({ documentId: created.value.documentId });
        },
        undefined,
        { draft },
      );
    }
    return this.commandExecutor.run(async () => {
      const folderId = await this.store.ensureFolderPath(dir);
      const doc = await this.store.createBinaryDocument({
        id: options.documentId,
        folderId,
        name,
        extension,
        fileType: options.fileType,
        storageUrl: options.storageUrl,
        mimeType: options.mimeType,
        sizeBytes: options.sizeBytes,
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });
      return Ok({ documentId: doc.id });
    });
  }

  async mkdir(path: string, _options?: ContextWriteOptions): Promise<Result<void, AdapterFault>> {
    const segments = path.split("/").filter(Boolean);
    // The source root always exists — empty `mkdir` is a no-op.
    if (segments.length === 0) return Ok(undefined);
    // An empty hidden folder would have no use (O-2).
    if (this.placement.kind === "draft") return Err(this.draftOnlyFault("make an empty folder"));
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
    const folderId = await this.findFolderId(view, path.split("/").filter(Boolean));
    if (folderId === MISSING) return Ok([]);

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
    const drafted = sourceDestination(this.scheme, view.draftWork).kind === "draft";
    return view.version !== "live" && drafted && view.draftWork
      ? { ...reader, destination: "draft", workId: view.draftWork.id as WorkId }
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
      const destinationFiletype = moveFiletypeTransition(source, prepared.destinationPath);
      if (!destinationFiletype.ok) return destinationFiletype;
      const committed = await this.mutationStore.commitMove({
        source,
        linkNoteProjectId: prepared.linkNoteProjectId,
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
        ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
        path: prepared.destinationPath,
      });
    }
    const source = prepared.source;
    const committed = await this.mutationStore.commitMove({
      source,
      linkNoteProjectId: prepared.linkNoteProjectId,
      destinationSourceId: prepared.destinationSourceId,
      destinationPath: prepared.destinationPath,
      expectedTarget: prepared.expectedTarget,
      overwrite: prepared.overwrite,
    });
    if (!committed.ok) return Err(this.mutationFault(committed.error));
    return Ok({
      movedNodeId: committed.value.movedNodeId,
      ...(committed.value.linkUpdate ? { linkUpdate: committed.value.linkUpdate } : {}),
      path: prepared.destinationPath,
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
      deletedDocumentIds: committed.value.deletedDocumentIds,
      availabilityGeneration: committed.value.availabilityGeneration,
    });
  }
}
