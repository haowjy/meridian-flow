/**
 * ContextFS's live create pipeline (contract §6.3, §6.4): discovery holding nothing, the
 * candidate's live lease when the create carries content, then one command transaction
 * that claims what was planned and initializes content. A live create at a hidden
 * document's path reveals it instead of inserting a twin; a changed candidate rolls back
 * and rediscovers once.
 *
 * The writer's instant create (`createOptimistic`) is the same pipeline: a branch's new
 * document is a real document, hidden only because it exists only in a branch, so a create
 * at its path unhides it. The device's minted id forwards to it. Nothing of its draft text
 * moves: the writer's text goes to live, and the document's draft stays pending for review.
 */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import {
  allocateFilename,
  type ContextSiblingPosition,
  type Filetype,
  type NamespaceNameClaim,
  namespaceName,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { testHook } from "../../../../shared/test-hooks.js";
import type {
  BoundWrite,
  DocumentCreationAggregate,
  DocumentSeedOrigin,
  HeldLiveDocument,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import { writeCollabMarkdownHeld } from "../../context/collab-document-sync.js";
import { joinPath, renderFilename } from "../../context/paths.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
  LiveCreateCandidateChangedError,
} from "../../ports/context-document-store.js";
import type { ContextWriteOptions } from "../../ports/context-port.js";
import type {
  LiveClaim,
  LiveCreateCandidate,
  RevealExpectation,
} from "../../tree/hidden-node-types.js";
import { LIVE_TREE } from "../../tree/tree-view.js";
import { type BoundWrites, DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { type CreateTarget, resolveCreateTarget } from "./create-target.js";

/**
 * What one live create does, decided before its transaction. A content reveal can't be
 * built without the lease it is admitted under and the address its content was bound for.
 */
export type LiveCreatePlan =
  /** No content: reveal the hidden document at the path, or insert. No lease needed. */
  | { kind: "empty" }
  /** No content, a caller-minted identity (untitled): insert, never trade it for another. */
  | { kind: "mint"; id: DocumentId }
  /** No content: reveal exactly the hidden document discovery found at the path. */
  | { kind: "reveal"; reveal: RevealExpectation }
  /** Content where discovery found nothing hidden; an upload may mint its reserved id. */
  | { kind: "insert-with-content"; content: BoundWrite; mintId?: DocumentId }
  /** Content into a revealed document, under the live lease the caller holds (B3). */
  | {
      kind: "reveal-with-content";
      content: BoundWrite;
      reveal: RevealExpectation;
      held: HeldLiveDocument;
      uri: string;
    };

function claimOf(plan: LiveCreatePlan): LiveClaim {
  switch (plan.kind) {
    case "empty":
      return { kind: "any" };
    case "mint":
      return { kind: "mint" };
    case "insert-with-content":
      return plan.mintId ? { kind: "mint" } : { kind: "none" };
    case "reveal":
    case "reveal-with-content":
      return { kind: "reveal", reveal: plan.reveal };
  }
}

function idOf(plan: LiveCreatePlan): DocumentId {
  switch (plan.kind) {
    case "mint":
      return plan.id;
    case "insert-with-content":
      return plan.mintId ?? crypto.randomUUID();
    case "reveal":
    case "reveal-with-content":
      return plan.reveal.documentId;
    case "empty":
      return crypto.randomUUID();
  }
}

/** Test-only injection point (contract §16.1); production never sets it. */
export type LiveCreateHookPoint = "liveCreate.afterHeldAdmission";
const hooks = new Map<LiveCreateHookPoint, () => Promise<void>>();

/** Installs a hook; the returned function removes it. */
export function setLiveCreateHook(
  point: LiveCreateHookPoint,
  hook: () => Promise<void>,
): () => void {
  hooks.set(point, hook);
  return () => {
    if (hooks.get(point) === hook) hooks.delete(point);
  };
}

export type OptimisticOutcome = {
  status: "created" | "already-exists" | "joined";
  /** The document: the device's id, or the one it joined. */
  documentId: DocumentId;
  /** Present when the outcome knows the document's address in this source. */
  path?: string;
  name?: string;
};

const UNTITLED_NAME_PATTERN = /^Untitled (\d+)$/;

function highestUntitled(filenames: ReadonlySet<string>): number {
  let max = 0;
  for (const filename of filenames) {
    const match = UNTITLED_NAME_PATTERN.exec(filename);
    const suffix = match ? Number(match[1]) : 0;
    if (Number.isSafeInteger(suffix) && suffix < Number.MAX_SAFE_INTEGER)
      max = Math.max(max, suffix);
  }
  return max;
}

class DocumentCreationFault extends Error {
  constructor(readonly fault: AdapterFault) {
    super("message" in fault ? fault.message : fault.code);
  }
}

type Discovery =
  | { kind: "conflict"; occupantKind?: "file" | "folder" }
  | { kind: "reveal"; reveal: RevealExpectation }
  | { kind: "none" };

type CreateAttempt =
  | { kind: "created"; documentId: string }
  | { kind: "leaf-conflict"; occupantKind?: "file" | "folder" };

export interface LiveCreateDeps {
  store: ContextDocumentStore;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: MarkdownDocumentStore;
  documentCreation: DocumentCreationAggregate;
  boundWrites: BoundWrites;
  projectId: ProjectId;
  holderUri(path: string): string;
  syncFault(error: SyncError): AdapterFault;
}

export class LiveCreate {
  constructor(private readonly deps: LiveCreateDeps) {}

  /**
   * A live create at `path` with optional content (create routes, imports, a whole-file
   * write on an absent path). With content, the candidate's lease is taken before the
   * transaction; a candidate that changed under the locks rediscovers once.
   */
  async create(
    path: string,
    content: BoundWrite | null,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const attempted = await this.createAttempt(path, content, options);
    if (!attempted.ok) return attempted;
    return attempted.value.kind === "created"
      ? Ok({ documentId: attempted.value.documentId })
      : Err({
          code: "conflict",
          ...(attempted.value.occupantKind ? { occupantKind: attempted.value.occupantKind } : {}),
        });
  }

  /**
   * Allocate a free document name and seed its content as one command. Batch claims are
   * caller reservations; live occupancy and races stay inside this operation.
   */
  async createAtFreeName(
    path: string,
    markdown: string,
    reserved: readonly NamespaceNameClaim[],
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string; path: string }, AdapterFault>> {
    const target = resolveCreateTarget(path);
    if (!target.ok) return target;
    let startSuffix = 1;
    for (;;) {
      let found: Exclude<Discovery, { kind: "conflict" }> | null = null;
      let checks = 0;
      const filename = await allocateFilename(
        { kind: "document", name: target.value.name, extension: target.value.extension },
        async (candidate) => {
          checks += 1;
          if (reserved.some((claim) => sameNamespaceName(candidate, claim))) return true;
          const candidatePath = joinPath(target.value.dir.join("/"), candidate.filename);
          const candidateTarget = resolveCreateTarget(candidatePath);
          if (!candidateTarget.ok) {
            throw new Error(`Allocator produced an invalid context path: ${candidatePath}`);
          }
          const discovery = await this.deps.executor.exclusive(() =>
            this.discover(candidateTarget.value),
          );
          if (discovery.kind === "conflict") return true;
          found = discovery;
          return false;
        },
        startSuffix,
      );
      const candidatePath = joinPath(target.value.dir.join("/"), filename);
      if (!found) throw new Error(`Free-name allocation did not inspect ${candidatePath}`);
      const binding =
        markdown.length > 0
          ? await this.deps.boundWrites.bind(candidatePath, null, markdown)
          : null;
      if (binding && !binding.ok) return binding;
      const attempted = await this.createAttempt(
        candidatePath,
        binding?.value ?? null,
        options,
        found,
      );
      if (!attempted.ok) return attempted;
      if (attempted.value.kind === "created") {
        return Ok({ documentId: attempted.value.documentId, path: candidatePath });
      }
      // Only admission can invalidate the accepted candidate. Continue after it rather than
      // replaying every occupied prefix through discovery.
      startSuffix += checks;
    }
  }

  private async createAttempt(
    path: string,
    content: BoundWrite | null,
    options?: ContextWriteOptions,
    initialDiscovery?: Exclude<Discovery, { kind: "conflict" }>,
  ): Promise<Result<CreateAttempt, AdapterFault>> {
    const target = resolveCreateTarget(path);
    if (!target.ok) return target;
    const withContent = content !== null && content.markdown.length > 0 ? content : null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const found =
        attempt === 0 && initialDiscovery
          ? initialDiscovery
          : await this.deps.executor.exclusive(() => this.discover(target.value));
      if (found.kind === "conflict") {
        return Ok({
          kind: "leaf-conflict",
          ...(found.occupantKind ? { occupantKind: found.occupantKind } : {}),
        });
      }
      // Holding nothing: a split or move may change the candidate before its sources lock.
      const sourceIds = found.kind === "reveal" ? [found.reveal.sourceId] : [];
      const run = (plan: LiveCreatePlan) =>
        this.deps.executor.run(
          () => this.inTransaction(path, target.value, plan, options),
          undefined,
          {
            sourceIds,
          },
        );
      try {
        if (found.kind === "none") {
          return await run(
            withContent
              ? {
                  kind: "insert-with-content",
                  content: withContent,
                  ...(options?.documentId ? { mintId: options.documentId } : {}),
                }
              : options?.documentId
                ? { kind: "mint", id: options.documentId }
                : { kind: "empty" },
          );
        }
        const { reveal } = found;
        return withContent
          ? await this.deps.documentSync.withLiveDocument(reveal.documentId, async (held) => {
              await testHook("createLive.afterLease");
              return run({
                kind: "reveal-with-content",
                content: withContent,
                reveal,
                held,
                uri: this.deps.holderUri(path),
              });
            })
          : await run({ kind: "reveal", reveal });
      } catch (error) {
        if (!(error instanceof LiveCreateCandidateChangedError)) throw error;
      }
    }
    return Ok({ kind: "leaf-conflict" });
  }

  /** §6.3 step 1 and §6.4's discovery, holding nothing. */
  private async discover(target: CreateTarget): Promise<Discovery> {
    const found = await this.deps.store.findLiveCreateCandidate(
      target.dir,
      target.name,
      target.extension,
    );
    if (found.kind === "occupant") {
      return {
        kind: "conflict",
        ...(found.occupantKind ? { occupantKind: found.occupantKind } : {}),
      };
    }
    if (found.kind === "none") return { kind: "none" };
    return {
      kind: "reveal",
      reveal: { documentId: found.documentId, sourceId: found.sourceId },
    };
  }

  /** Inside the command transaction: folders, the visible-occupant check, then the claim. */
  private async inTransaction(
    path: string,
    target: CreateTarget,
    plan: LiveCreatePlan,
    options?: ContextWriteOptions,
  ): Promise<Result<CreateAttempt, AdapterFault>> {
    const folderId = await this.deps.store.ensureFolderPath(target.dir);
    const existing = await this.deps.store.findDocument(folderId, target.name, target.extension);
    if (existing) {
      return Ok({ kind: "leaf-conflict", occupantKind: "file" });
    }
    if (
      (plan.kind === "insert-with-content" || plan.kind === "reveal-with-content") &&
      !this.deps.boundWrites.boundFor(path, plan.content, null)
    ) {
      return Err({ code: "stale_target" });
    }
    const created = await this.atomically({ ...target, folderId }, plan, { options });
    if (created.ok) return Ok({ kind: "created", documentId: created.value.document.id });
    return created.error.code === "conflict"
      ? Ok({
          kind: "leaf-conflict",
          ...(created.error.occupantKind ? { occupantKind: created.error.occupantKind } : {}),
        })
      : created;
  }

  /**
   * The writer's instant create under the id their device minted (New file, a link's
   * Create, the editor's New document): never refused for a name. At the final path:
   * nothing there inserts the device's id; a branch's hidden text document there is
   * unhidden, keeps its own id, and the device's id forwards to it (`joined`); a visible
   * node there leaves the create at the first free name. A replay answers from the
   * forward first. `leaf` is null for a nameless create, which takes `Untitled N`.
   */
  async createOptimistic(input: {
    dir: readonly string[];
    leaf: { name: string; extension: string; filetype: Filetype } | null;
    documentId: DocumentId;
    /** The folder identity the destination named; a different folder here is stale. */
    expectFolderId?: string;
    /** Where among the folder's children a new document goes; a reveal keeps its place. */
    position?: ContextSiblingPosition;
    options: ContextWriteOptions;
  }): Promise<Result<OptimisticOutcome, AdapterFault>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { leaf } = input;
      const found = leaf
        ? await this.deps.executor.exclusive(() =>
            this.deps.store.findLiveCreateCandidate(input.dir, leaf.name, leaf.extension),
          )
        : { kind: "none" as const };
      const sourceIds = found.kind === "candidate" ? [found.sourceId] : [];
      try {
        return await this.deps.executor.run(
          () => this.optimisticInTransaction(input, found),
          undefined,
          { sourceIds },
        );
      } catch (error) {
        if (!(error instanceof LiveCreateCandidateChangedError)) throw error;
      }
    }
    return Err({ code: "conflict" });
  }

  private async optimisticInTransaction(
    input: Parameters<LiveCreate["createOptimistic"]>[0],
    found: LiveCreateCandidate,
  ): Promise<Result<OptimisticOutcome, AdapterFault>> {
    const { store, projectId } = this.deps;
    // A replay of a create that joined: the forward answers before any path is read.
    const forwarded = await store.findForward(input.documentId, projectId);
    if (forwarded) return Ok({ status: "joined", documentId: forwarded as DocumentId });

    const sourceId = await store.contextSourceId();
    const alreadyHere = async (): Promise<OptimisticOutcome | null> => {
      const existing = await store.findDocumentById(LIVE_TREE, input.documentId);
      if (!existing || existing.contextSourceId !== sourceId) return null;
      return {
        status: "already-exists",
        documentId: existing.document.id as DocumentId,
        path: existing.path,
      };
    };
    const here = await alreadyHere();
    if (here) return Ok(here);

    const folderId = await store.ensureFolderPath([...input.dir]);
    if (input.expectFolderId !== undefined && folderId !== input.expectFolderId) {
      return Err({ code: "stale_target" });
    }
    const extra = { options: input.options };
    const live = [
      ...(await store.listDocuments(LIVE_TREE, folderId)).map(
        (document) =>
          ({
            kind: "document",
            filename: renderFilename(document.name, document.extension),
          }) as const,
      ),
      ...(await store.listFolders(LIVE_TREE, folderId)).map(
        (folder) => ({ kind: "folder", filename: folder.name }) as const,
      ),
    ];
    let target: { name: string; extension: string; filetype: Filetype };
    let plan: LiveCreatePlan;
    let joinFrom: DocumentId | undefined;
    if (input.leaf === null) {
      // Untitled names skip what hidden documents hold: a scratch never joins an AI document.
      const hiddenNames = await store.listHiddenNames(folderId);
      const taken = new Set([...live.map(namespaceName), ...hiddenNames]);
      target = {
        name: `Untitled ${highestUntitled(taken) + 1}`,
        extension: "",
        filetype: DEFAULT_EDITABLE_FILETYPE,
      };
      plan = { kind: "mint", id: input.documentId };
    } else {
      const free = await allocateFilename({ kind: "document", ...input.leaf }, (candidate) =>
        live.some((claim) => sameNamespaceName(candidate, claim)),
      );
      const parsedFree = input.leaf.extension
        ? free.slice(0, -(input.leaf.extension.length + 1))
        : free;
      target = { ...input.leaf, name: parsedFree };
      const atTypedName = parsedFree === input.leaf.name;
      if (atTypedName && found.kind === "candidate") {
        plan = {
          kind: "reveal",
          reveal: { documentId: found.documentId, sourceId: found.sourceId },
        };
        joinFrom = input.documentId;
      } else plan = { kind: "mint", id: input.documentId };
    }
    const created = await this.atomically({ ...target, folderId }, plan, {
      ...extra,
      provisionalName: input.leaf === null,
      ...(input.position ? { position: input.position } : {}),
      ...(joinFrom ? { joinFrom } : {}),
    });
    if (created.ok) {
      const { document, revealed } = created.value;
      return Ok({
        status: revealed ? "joined" : "created",
        documentId: document.id as DocumentId,
        name: renderFilename(document.name, document.extension),
      });
    }
    if (created.error.code !== "conflict") return created;
    const landed = await alreadyHere();
    if (landed) return Ok(landed);
    const raced = await store.findForward(input.documentId, projectId);
    return raced
      ? Ok({ status: "joined", documentId: raced as DocumentId })
      : Err({ code: "conflict" });
  }

  /**
   * Identity, content and arrival in one aggregate, at a resolved folder, under the claim
   * `plan` makes. The caller holds the command transaction.
   */
  async atomically(
    target: { folderId: string | null; name: string; extension: string; filetype: Filetype },
    plan: LiveCreatePlan,
    extra: {
      provisionalName?: boolean;
      options?: ContextWriteOptions;
      /** The device's create id a reveal forwards to the revealed document. */
      joinFrom?: DocumentId;
      position?: ContextSiblingPosition;
    } = {},
  ): Promise<
    Result<{ document: ContextDocument; markdown: string; revealed: boolean }, AdapterFault>
  > {
    const { options } = extra;
    let document: ContextDocument | null = null;
    let revealed = false;
    try {
      const created = await this.deps.documentCreation.createDocumentAtomically({
        persistIdentity: async () => {
          const claimed = await this.deps.store.createDocumentRecordIfAbsent(
            {
              id: idOf(plan),
              folderId: target.folderId,
              name: target.name,
              extension: target.extension,
              markdown: "",
              filetype: target.filetype,
              provisionalName: extra.provisionalName,
              ...(extra.position ? { position: extra.position } : {}),
              ...(extra.joinFrom
                ? { joinFrom: { fromId: extra.joinFrom, projectId: this.deps.projectId } }
                : {}),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
            },
            claimOf(plan),
          );
          document = claimed?.document ?? null;
          revealed = claimed?.revealed ?? false;
          return claimed?.document.id ?? null;
        },
        initializeContent: (documentId) => this.initializeContent(documentId, plan, options),
      });
      if (!created.created) return Err({ code: "conflict", occupantKind: "file" });
      if (!document) {
        return Err({ code: "io_error", message: "Created document identity was not returned" });
      }
      return Ok({ document, markdown: created.value, revealed });
    } catch (error) {
      if (error instanceof DocumentCreationFault) return Err(error.fault);
      if (error instanceof ContextEntryConflictError) {
        return Err({
          code: "conflict",
          ...(error.occupantKind ? { occupantKind: error.occupantKind } : {}),
        });
      }
      throw error;
    }
  }

  private async initializeContent(
    documentId: DocumentId,
    plan: LiveCreatePlan,
    options?: ContextWriteOptions,
  ): Promise<string> {
    switch (plan.kind) {
      case "empty":
      case "mint":
        await this.deps.documentSync.initializeEmptyDocument(documentId);
        return "";
      case "reveal":
        // A revealed document's live Yjs exists (empty: a draft never seeds it); an old
        // anomaly missing it is repaired on this explicit touch.
        await this.deps.documentSync.repairDocumentAuthority(documentId);
        return "";
      case "reveal-with-content": {
        // The claim confirmed exactly `plan.reveal`, so the held lease is this document's.
        const written = await writeCollabMarkdownHeld({
          documentSync: this.deps.documentSync,
          held: plan.held,
          content: plan.content,
          expected: { documentId, uri: plan.uri },
          provenance: options?.origin,
        });
        if (!written.ok) throw new DocumentCreationFault(written.error);
        await hooks.get("liveCreate.afterHeldAdmission")?.();
        return written.markdown;
      }
      case "insert-with-content": {
        const provenance = options?.origin;
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
        const seeded = await this.deps.documentSync.seedFromMarkdown(
          documentId,
          plan.content,
          origin,
        );
        if (!seeded.ok) throw new DocumentCreationFault(this.deps.syncFault(seeded.error));
        return plan.content.markdown;
      }
    }
  }
}
