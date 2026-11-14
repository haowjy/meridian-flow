/**
 * ContextFS: filesystem-shaped adapter for Meridian-managed context schemes
 * (`manuscript`/`kb`/`scratch`/`user`/`uploads`). It hides the document-store +
 * Yjs backing behind path-oriented filesystem operations; every create, move and delete is a
 * record of the project's list made at the call (`tree-writes.ts`).
 */

import { type CanonicalContextAuthority, canonicalContextUri } from "@meridian/contracts";
import {
  canonicalLeaf,
  type ParsedDocumentFilename,
  parseDocumentFilename,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { compareCatalogSiblings, LIVE } from "@meridian/project-tree";
import { Err, Ok, type Result } from "../../../../shared/result.js";
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
  AdapterDeleted,
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterGrepFile,
  AdapterGrepResult,
  AdapterMovedAcrossLists,
  ContextEnsureTrackedOptions,
  ContextSchemeAdapter,
  ContextTreeAdapter,
  SchemeCapabilities,
  TreeCommandInput,
  TreeReadInput,
} from "../../ports/context-adapter.js";
import { schemeCapabilities } from "../../ports/context-adapter.js";
import type { ContextCommandTransaction } from "../../ports/context-command-transaction.js";
import type { ContextCopyAdapter } from "../../ports/context-copy.js";
import type { ContextDocument, ContextDocumentStore } from "../../ports/context-document-store.js";
import type {
  ContextListOptions,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  GrepQuery,
  GrepShowing,
  ThreadContextView,
  WriteProvenance,
} from "../../ports/context-port.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { LineageScratchUnavailableError } from "../lineage-scratch-lifecycle.js";
import { BoundWrites, binaryTrackedWriteFault } from "./bound-writes.js";
import { createContextFsCopyAdapter } from "./copy-adapter.js";
import { fileRefOf } from "./file-ref.js";
import { type GrepRead, scanDocuments } from "./grep-scan.js";
import { LiveCreate } from "./live-create.js";
import {
  AMBIGUOUS_PATH_FAULT,
  type ContextPlacement,
  type CreatePlacement,
  createPlacement,
} from "./placement.js";
import { actorOf, type SourceTree, type TreeWriteTarget, viewOfBranch } from "./tree-writes.js";

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
  /** This source's tree writes: records of the project's list. */
  writes: SourceTree;
  /** Who a person's Copy through this adapter is attributed to: `user:<id>`. */
  actor: string;
  /** Settles ahead refs when a document arrives; absent in a composition without them. */
  arrivals?: DocumentArrivals;
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

/**
 * Store-backed file tree for project and work context schemes.
 *
 * Content is Yjs-canonical: the tree is the project's list (read through the store's views,
 * written by records made at the call), and read/write content flows through the collab domain.
 * A create, move or delete runs in one command transaction: the Work and branch locks first,
 * then the list's lock inside `treeListStore.submit`, then the document's own.
 */
export class ContextFS implements ContextSchemeAdapter {
  readonly name: string;
  readonly capabilities: SchemeCapabilities;

  private readonly links: ContextFSDeps["links"];
  private readonly store: ContextDocumentStore;
  private readonly writes: SourceTree;
  private readonly documentSync: ContextFSDeps["documentSync"];
  private readonly commandExecutor: ResultAwareCommandExecutor<AdapterFault>;
  private readonly placement: CreatePlacement;
  private readonly liveCreate: LiveCreate;
  private readonly readView?: ThreadContextView;
  private readonly scheme: ContextScheme;
  private readonly holder: ContextFSDeps["holder"];
  private readonly boundWrites: BoundWrites;

  readonly tree: ContextTreeAdapter = {
    sourceId: () => this.store.contextSourceId(),
    moveAcrossLists: (input) => this.moveAcrossLists(input),
    delete: (input) => this.deleteNode(input),
    command: (input) => this.treeCommand(input),
    read: (input) => this.treeRead(input),
  };
  /** Copy's read and insert halves (`context/copy/` decides what to copy). */
  readonly copy: ContextCopyAdapter;

  constructor(deps: ContextFSDeps) {
    this.links = deps.links;
    this.capabilities = schemeCapabilities(deps.scheme);
    this.store = deps.store;
    this.writes = deps.writes;
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
      tree: deps.writes,
      executor: this.commandExecutor,
      documentSync: deps.documentSync,
      documentCreation,
      boundWrites: this.boundWrites,
      ...(deps.arrivals ? { arrivals: deps.arrivals } : {}),
      holderUri: (path) => this.holderUri(path),
      syncFault: (error) => this.syncFault(error),
    });
    this.placement = createPlacement(deps.placement, {
      store: deps.store,
      tree: deps.writes,
      executor: this.commandExecutor,
      documentSync: deps.documentSync,
      ...(deps.arrivals ? { arrivals: deps.arrivals } : {}),
      liveCreate: this.liveCreate,
    });
    this.copy = createContextFsCopyAdapter({
      store: deps.store,
      writes: deps.writes,
      actor: deps.actor,
      documentCreation,
      documentSync: deps.documentSync,
      ...(deps.arrivals ? { arrivals: deps.arrivals } : {}),
      holderUri: (path) => this.holderUri(path),
      folderUri: (path) => canonicalContextUri(this.scheme, path, this.holder.authority),
      refuseReceive: () => this.placement.refuse("receive a copy"),
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
   * What reads see: a draft placement's Work's active branch, unless the thread asked for
   * the live text; live otherwise. Resolved once per command, never creating a branch.
   */
  private readTreeView(): Promise<TreeView> {
    return this.placement.readView(this.readView?.version);
  }

  /**
   * The document `path` addresses in `view`, by any spelling the store resolves. A path two of
   * the view's files share is the clash fault, never one of them.
   */
  private async findDocumentAt(
    view: TreeView,
    path: string,
  ): Promise<Result<ContextDocument | null, AdapterFault>> {
    const parsed = parseDocumentPath(path);
    if (!parsed.ok || !parsed.value) return Ok(null);
    const found = await this.store.resolveDocumentAt(view, path);
    if (found.kind === "ambiguous") return Err(AMBIGUOUS_PATH_FAULT);
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
    return canonicalContextUri(
      this.scheme,
      joinPath(dir.join("/"), canonicalLeaf(filename)),
      this.holder.authority,
    );
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

  ensureTrackedDocument(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<{ documentId: string; created: boolean }, AdapterFault>> {
    return this.placement.ensureTracked(path, options);
  }

  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<{ documentId: string; placement: "live" | "draft" }, AdapterFault>> {
    return this.placement.writeBinary(path, options);
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
    ].sort((left, right) => compareCatalogSiblings(left.order, right.order));
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
      const ref = fileRefOf(doc, joinPath(path, renderFilename(doc.name, doc.extension)));
      if (!ref.ok) return ref;
      const file = ref.value;
      entries.push({
        path: joinPath(path, renderFilename(doc.name, doc.extension)),
        kind: "file",
        documentId: doc.id,
        sizeBytes: doc.sizeBytes ?? undefined,
        updatedAt: doc.updatedAt,
        ...(file.kind === "tracked"
          ? {
              editable: true as const,
              filetype: file.filetype,
              schemaType: file.schemaType,
              ...(wordCounts.has(doc.id as DocumentId)
                ? { wordCount: wordCounts.get(doc.id as DocumentId) }
                : {}),
            }
          : {
              editable: false as const,
              fileType: file.fileType,
              mimeType: file.mimeType,
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
  private threadView(): ({ threadId: ThreadId } & EffectiveReadVersion) | null {
    const view = this.readView;
    if (!view) return null;
    const reader = { threadId: view.threadId as ThreadId };
    // Without a separate draft both versions are the same document.
    const drafted = sourceDestination(this.scheme, view.branchOwner).kind === "draft";
    return view.version !== "live" && drafted && view.branchOwner
      ? { ...reader, destination: "draft", owner: view.branchOwner.owner }
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

  /**
   * A tree command in this source: the records of one command transaction. A drafted one is a
   * record of the Work's branch, which the transaction makes and locks; a live one is live.
   * `afterWrite` runs inside it once the records are made.
   */
  private async inTreeCommand<T>(
    input: { origin?: WriteProvenance; drafted?: boolean; fromSourceId: string },
    write: (target: TreeWriteTarget) => Promise<Result<T, AdapterFault>>,
  ): Promise<Result<T, AdapterFault>> {
    const actor = actorOf(input.origin);
    if (!input.drafted)
      return this.commandExecutor.run(() => write({ view: LIVE, actor }), undefined, {
        sourceIds: [input.fromSourceId],
      });
    const owner = this.placement.branchOwner;
    if (!owner) return Err({ code: "permission_denied" });
    return this.commandExecutor.runInBranch(
      { ...owner, mode: "ensure" },
      (branch) => write({ view: viewOfBranch(branch.id), actor }),
      [input.fromSourceId],
    );
  }

  private async treeCommand<T>(input: TreeCommandInput<T>): Promise<Result<T, AdapterFault>> {
    const fromSourceId = await this.store.contextSourceId();
    return this.inTreeCommand({ ...input, fromSourceId }, async (target) => {
      let arrived: readonly string[] = [];
      const result = await this.writes.run(target, (scope) => {
        const made = input.make(scope);
        arrived = made.arrived ?? [];
        return made;
      });
      await input.afterWrite?.(result, { view: target.view });
      // Only live documents arrive at a live address; a drafted one has none.
      if (!target.view.draft && arrived.length > 0)
        await this.liveCreate.arrive(arrived as DocumentId[]);
      return Ok(result);
    });
  }

  private async treeRead<T>(input: TreeReadInput<T>): Promise<Result<T, AdapterFault>> {
    const shown = await this.placement.readView(input.version ?? this.readView?.version);
    return Ok(
      await this.writes.read(
        shown.kind === "live" ? LIVE : viewOfBranch(shown.branchId),
        input.read,
      ),
    );
  }

  private moveAcrossLists(
    input: Parameters<ContextTreeAdapter["moveAcrossLists"]>[0],
  ): Promise<Result<AdapterMovedAcrossLists, AdapterFault>> {
    return this.inTreeCommand({ ...input, fromSourceId: input.fromSourceId }, async (target) => {
      const moved = await this.writes.moveAcrossLists(target, {
        node: input.node.nodeId,
        fromSourceId: input.fromSourceId,
        dir: input.dir,
        ...(input.leaf !== undefined ? { leaf: input.leaf } : {}),
        ...(input.position ? { position: input.position } : {}),
        ...(input.onlyAt !== undefined ? { onlyAt: input.onlyAt } : {}),
      });
      if (!moved.ok) return moved;
      const result: AdapterMovedAcrossLists = {
        node: input.node.nodeId,
        path: moved.value.path.join("/"),
        records: { left: moved.value.left.id, entered: moved.value.entered.id },
      };
      await input.afterWrite?.(result);
      // Arriving at a live address: once per move, against the tree it entered (contract §9.3).
      await this.liveCreate.arrive([input.node.nodeId as DocumentId]);
      return Ok(result);
    });
  }

  private deleteNode(
    input: Parameters<ContextTreeAdapter["delete"]>[0],
  ): Promise<Result<AdapterDeleted, AdapterFault>> {
    return this.inTreeCommand(input, async (target) => {
      const deleted = await this.writes.delete(target, {
        node: input.node.nodeId,
        kind: input.node.kind,
        fromSourceId: input.fromSourceId,
        ...(input.onlyAt !== undefined ? { onlyAt: input.onlyAt } : {}),
      });
      if (!deleted.ok) return deleted;
      const result: AdapterDeleted = {
        path: deleted.value.path.join("/"),
        documentIds: deleted.value.documentIds,
      };
      await input.afterWrite?.(result);
      return Ok(result);
    });
  }
}
