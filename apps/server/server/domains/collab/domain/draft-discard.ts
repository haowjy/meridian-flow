/**
 * Discard (contract §12): one kernel for one item, the whole draft and Work purge. The
 * public command `discardItems` (writer and model) takes §14's in-process leases first —
 * every branch of the draft for a whole Discard, the items' branches and their live
 * documents for an item Discard — then the store's one transaction: the Work, active
 * (D30), the draft, the namespaces and documents, and the kernel. The kernel resets each
 * item's text from live, or closes every branch with the draft, and ends the draft's use
 * of what it created: what no draft uses any more is tombstoned and its storage released.
 * Purge runs the kernel in its own transaction after its own lifecycle proof (§2.6).
 */
import type { DraftId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { NodeRef } from "../../context/tree/tree-view.js";
import { BranchCasConflictError } from "./branch-coordinator.js";
import type { BranchCriticalSections, BranchLockLease } from "./branch-critical-sections.js";
import { collabHook } from "./collab-test-hooks.js";
import type { DraftBranchLeases } from "./draft-branch-leases.js";
import type { DraftItemKey } from "./draft-publication.js";
import type { DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";

export type DiscardSelection =
  | { kind: "items"; itemKeys: readonly DraftItemKey[] }
  | { kind: "whole" };

export type DiscardResult =
  | { status: "discarded"; draftId: DraftId; draftClosed: boolean }
  | { status: "gone"; draftId: DraftId };

export interface DraftDiscard {
  /** The public command: writer and model. Refuses archived and deleted Works (D30). */
  discardItems(input: {
    workId: WorkId;
    draftId: DraftId;
    selection: DiscardSelection;
    userId?: UserId;
    threadId?: ThreadId;
  }): Promise<DiscardResult>;
}

/** One selected item as the kernel ends it. */
export type DiscardItem = {
  documentId: DocumentId;
  /** The draft's branch on it; null for a created image. */
  draftBranchId: string | null;
  origin: "created" | "edited";
};

export type DiscardKernelInput =
  /** Item text resets need the leased branches and the live documents they reset from. */
  | {
      draftId: DraftId;
      selection: { kind: "items"; items: readonly DiscardItem[] };
      lease: BranchLockLease;
      liveDocs: ReadonlyMap<DocumentId, Y.Doc>;
    }
  /** A whole Discard closes every branch and resets no text (purge passes this). */
  | { draftId: DraftId; selection: { kind: "whole" } };

export type DiscardKernelResult = {
  draftClosed: boolean;
  tombstoned: readonly NodeRef[];
  /** Storage URLs of tombstoned binaries: deleted after commit, best effort. */
  releasedObjects: readonly string[];
};

/** An active branch of the draft, by document. */
export type DraftBranchRef = { branchId: string; documentId: DocumentId };

export interface DraftDiscardStore {
  /** No lock: the draft's active branches, both kinds, on these documents (all, if absent). */
  activeBranches(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<readonly DraftBranchRef[]>;
  /**
   * `discardItems`' transaction (§12.2): the Work, refusing an archived or deleted one;
   * the draft (null: not active any more); proof that no branch outside `leased` became
   * active; the namespaces and documents; the kernel inside the Work's pending projection.
   */
  discardLocked(input: {
    workId: WorkId;
    kernel: DiscardKernelInput;
    leased: ReadonlySet<string>;
  }): Promise<DiscardKernelResult | null>;
}

/**
 * The draft grew a branch, or one of its created documents moved to another source,
 * between discovery and the locks: discover and lease again.
 */
export class DraftDiscardScopeChangedError extends Error {
  constructor(readonly draftId: DraftId) {
    super(`Draft ${draftId} changed while its Discard was taking its locks`);
    this.name = "DraftDiscardScopeChangedError";
  }
}

const ATTEMPTS = 4;

export function createDraftDiscard(deps: {
  drafts: Pick<Drafts, "byIds">;
  reviewItems: Pick<DraftReviewItems, "list">;
  draftLeases: DraftBranchLeases;
  criticalSections: BranchCriticalSections;
  liveCoordinator: {
    withDocument<T>(documentId: string, run: (doc: Y.Doc) => Promise<T>): Promise<T>;
  };
  store: DraftDiscardStore;
  /** After commit: drop thread runtimes holding reset text (item Discard only). */
  invalidateThread(documentId: DocumentId, threadId: string): Promise<void>;
  /** After commit: delete tombstoned binaries' objects, best effort. */
  releaseObjects(storageUrls: readonly string[]): Promise<void>;
}): DraftDiscard {
  /** Every one of these live documents' coordinator leases, in document-id order. */
  function withLiveDocuments<T>(
    ids: readonly DocumentId[],
    run: (docs: ReadonlyMap<DocumentId, Y.Doc>) => Promise<T>,
  ): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    const docs = new Map<DocumentId, Y.Doc>();
    const step = (index: number): Promise<T> => {
      const id = ordered[index];
      if (id === undefined) return run(docs);
      return deps.liveCoordinator.withDocument(id, async (doc) => {
        docs.set(id, doc);
        return step(index + 1);
      });
    };
    return step(0);
  }

  async function retrying<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 1; ; tries += 1) {
      try {
        return await attempt();
      } catch (cause) {
        const again =
          cause instanceof BranchCasConflictError || cause instanceof DraftDiscardScopeChangedError;
        if (!again || tries >= ATTEMPTS) throw cause;
      }
    }
  }

  async function whole(workId: WorkId, draftId: DraftId): Promise<DiscardKernelResult | null> {
    return deps.draftLeases.withDraftBranches(draftId, async (_lease, branchIds) => {
      await collabHook("discard.afterLeases");
      return deps.store.discardLocked({
        workId,
        kernel: { draftId, selection: { kind: "whole" } },
        leased: new Set(branchIds),
      });
    });
  }

  async function items(
    workId: WorkId,
    draftId: DraftId,
    selected: readonly DiscardItem[],
  ): Promise<DiscardKernelResult | null> {
    const documentIds = selected.map((item) => item.documentId);
    const branches = await deps.store.activeBranches(draftId, documentIds);
    const branchIds = branches.map((ref) => ref.branchId);
    const textDocuments = selected.flatMap((item) => (item.draftBranchId ? [item.documentId] : []));
    return deps.criticalSections.withBranches(branchIds, async (lease) => {
      await collabHook("discard.afterLeases");
      return withLiveDocuments(textDocuments, (liveDocs) =>
        deps.store.discardLocked({
          workId,
          kernel: { draftId, selection: { kind: "items", items: selected }, lease, liveDocs },
          leased: new Set(branchIds),
        }),
      );
    });
  }

  return {
    async discardItems(input) {
      const { draftId, workId } = input;
      const gone = { status: "gone" as const, draftId };
      const [draft] = await deps.drafts.byIds([draftId]);
      if (draft?.status !== "active" || draft.originWorkId !== workId) return gone;

      if (input.selection.kind === "whole") {
        const ended = await retrying(() => whole(workId, draftId));
        if (!ended) return gone;
        await deps.releaseObjects(ended.releasedObjects);
        return { status: "discarded", draftId, draftClosed: true };
      }

      // Items the writer saw that are no longer pending were discarded or applied already.
      const keys = new Set(input.selection.itemKeys);
      const selected = (await deps.reviewItems.list(draftId))
        .filter((item) => keys.has(item.itemKey))
        .map(
          (item): DiscardItem => ({
            documentId: item.documentId,
            draftBranchId: item.draftBranchId,
            origin: item.origin,
          }),
        );
      if (selected.length === 0) return { status: "discarded", draftId, draftClosed: false };
      const ended = await retrying(() => items(workId, draftId, selected));
      if (!ended) return gone;
      await deps.releaseObjects(ended.releasedObjects);
      for (const item of selected) {
        await deps.invalidateThread(item.documentId, input.threadId ?? "");
      }
      return { status: "discarded", draftId, draftClosed: false };
    },
  };
}
