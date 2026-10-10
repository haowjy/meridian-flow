/**
 * ContextFS's live create pipeline (contract §6.3, §6.4): discovery holding nothing, the
 * candidate's live lease when the create carries content, then one command transaction
 * that claims what was planned and initializes content. A live create at a hidden
 * document's path reveals it instead of inserting a twin; Create by id reveals only a
 * hidden identity of this project; a changed candidate rolls back and rediscovers once.
 */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type {
  BoundWrite,
  DocumentCreationAggregate,
  DocumentSeedOrigin,
  HeldLiveDocument,
  MarkdownDocumentStore,
  SyncError,
} from "../../../collab/index.js";
import { writeCollabMarkdownHeld } from "../../context/collab-document-sync.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  LiveCreateCandidateChangedError,
} from "../../ports/context-document-store.js";
import type { ContextWriteOptions } from "../../ports/context-port.js";
import type { LiveClaim, RevealExpectation } from "../../tree/hidden-node-types.js";
import { LIVE_TREE } from "../../tree/tree-view.js";
import { type BoundWrites, binaryTrackedWriteFault } from "./bound-writes.js";
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
  /** No content: reveal exactly this hidden document. */
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

class DocumentCreationFault extends Error {
  constructor(readonly fault: AdapterFault) {
    super("message" in fault ? fault.message : fault.code);
  }
}

type Discovery =
  | { kind: "conflict" }
  | { kind: "existing"; documentId: DocumentId }
  | { kind: "reveal"; reveal: RevealExpectation }
  | { kind: "none" };

export interface LiveCreateDeps {
  store: ContextDocumentStore;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: MarkdownDocumentStore;
  documentCreation: DocumentCreationAggregate;
  boundWrites: BoundWrites;
  projectId: ProjectId;
  holderUri(path: string): string;
  syncFault(error: SyncError): AdapterFault;
  findDocumentAt(path: string): Promise<ContextDocument | null>;
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
    const target = resolveCreateTarget(path);
    if (!target.ok) return target;
    const withContent = content !== null && content.markdown.length > 0 ? content : null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const found = await this.deps.executor.exclusive(() =>
        this.discover(path, target.value, options),
      );
      if (found.kind === "conflict") return Err({ code: "conflict" });
      if (found.kind === "existing") return Ok({ documentId: found.documentId });
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
          ? await this.deps.documentSync.withLiveDocument(reveal.documentId, (held) =>
              run({
                kind: "reveal-with-content",
                content: withContent,
                reveal,
                held,
                uri: this.deps.holderUri(path),
              }),
            )
          : await run({ kind: "reveal", reveal });
      } catch (error) {
        if (!(error instanceof LiveCreateCandidateChangedError)) throw error;
      }
    }
    return Err({ code: "conflict" });
  }

  /** §6.3 step 1 and §6.4's discovery, holding nothing. */
  private async discover(
    path: string,
    target: CreateTarget,
    options?: ContextWriteOptions,
  ): Promise<Discovery> {
    const named = options?.revealDocumentId;
    if (named) {
      const identity = await this.deps.store.findRevealIdentity(named, this.deps.projectId);
      if (identity.kind === "hidden") {
        return {
          kind: "reveal",
          reveal: {
            documentId: identity.documentId,
            sourceId: identity.sourceId,
            byId: true,
            projectId: this.deps.projectId,
          },
        };
      }
      if (identity.kind === "visible" && (await this.deps.findDocumentAt(path))?.id === named) {
        return { kind: "existing", documentId: named };
      }
      // Missing, a tombstone, elsewhere or another project's: never minted (C-R4).
      return { kind: "conflict" };
    }
    const found = await this.deps.store.findLiveCreateCandidate(
      target.dir,
      target.name,
      target.extension,
    );
    if (found.kind === "occupant") return { kind: "conflict" };
    if (found.kind === "none") return { kind: "none" };
    return {
      kind: "reveal",
      reveal: { documentId: found.documentId, sourceId: found.sourceId, byId: false },
    };
  }

  /** Inside the command transaction: folders, the visible-occupant check, then the claim. */
  private async inTransaction(
    path: string,
    target: CreateTarget,
    plan: LiveCreatePlan,
    options?: ContextWriteOptions,
  ): Promise<Result<{ documentId: string }, AdapterFault>> {
    const folderId = await this.deps.store.ensureFolderPath(target.dir);
    const existing = await this.deps.store.findDocument(
      LIVE_TREE,
      folderId,
      target.name,
      target.extension,
    );
    if (existing) {
      return Err(existing.fileType !== null ? binaryTrackedWriteFault(path) : { code: "conflict" });
    }
    if (
      (plan.kind === "insert-with-content" || plan.kind === "reveal-with-content") &&
      !this.deps.boundWrites.boundFor(path, plan.content, null)
    ) {
      return Err({ code: "stale_target" });
    }
    const created = await this.atomically({ ...target, folderId }, plan, { options });
    return created.ok ? Ok({ documentId: created.value.document.id }) : created;
  }

  /**
   * Identity, content and arrival in one aggregate, at a resolved folder, under the claim
   * `plan` makes. The caller holds the command transaction.
   */
  async atomically(
    target: { folderId: string | null; name: string; extension: string; filetype: Filetype },
    plan: LiveCreatePlan,
    extra: { provisionalName?: boolean; options?: ContextWriteOptions } = {},
  ): Promise<Result<{ document: ContextDocument; markdown: string }, AdapterFault>> {
    const { options } = extra;
    let document: ContextDocument | null = null;
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
              ...(options?.metadata ? { metadata: options.metadata } : {}),
            },
            claimOf(plan),
          );
          document = claimed?.document ?? null;
          return claimed?.document.id ?? null;
        },
        initializeContent: (documentId) => this.initializeContent(documentId, plan, options),
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

  private async initializeContent(
    documentId: DocumentId,
    plan: LiveCreatePlan,
    options?: ContextWriteOptions,
  ): Promise<string> {
    switch (plan.kind) {
      case "empty":
      case "mint":
      case "reveal":
        // A revealed document's live Yjs is already empty: a draft never seeds it.
        await this.deps.documentCreation.ensureDocument(documentId);
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
