/**
 * Discard (contract §12): one kernel for one item, the whole draft and Work purge. The
 * public command `discardItems` (writer and model) takes §14's in-process leases first —
 * every branch of the draft for a whole Discard, the items' branches and their live
 * documents for an item Discard — then the store's one transaction: the Work, active
 * (D30), the draft, the namespaces and documents, and the kernel. The kernel closes the
 * items' branches (item Discard is close-only, W9), or every branch with the draft, and ends the draft's use
 * of what it created: what no draft uses any more is tombstoned and its storage released.
 * Purge runs the kernel in its own transaction after its own lifecycle proof (§2.6).
 */
import type { DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DraftCommandOutcome } from "@meridian/contracts/drafts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { NodeRef } from "../../context/tree/tree-view.js";
import { BranchCasConflictError } from "./branch-coordinator.js";
import type { BranchCriticalSections } from "./branch-critical-sections.js";
import { collabHook } from "./collab-test-hooks.js";
import type { DraftBranchLeases } from "./draft-branch-leases.js";
import type { DraftCommandEnvelope } from "./draft-commands.js";
import type { Drafts } from "./drafts.js";
import type { PeerRetirement, RetiredBranch } from "./peer-retirement.js";

export type DiscardSelection = { kind: "items"; items: readonly DiscardItem[] } | { kind: "whole" };

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
    /** The writer's command, claimed `done` in the kernel's transaction with this result (§4.6). */
    command?: { envelope: DraftCommandEnvelope; result: DraftCommandOutcome };
  }): Promise<DiscardResult>;
}

/** One selected item as the kernel ends it. */
export type DiscardItem = {
  documentId: DocumentId;
  /** The draft's branch on it; null for a created image. */
  draftBranchId: string | null;
  /** Provenance only: the kernel classifies by the document's visibility under its locks (§2.2). */
  origin: "created" | "edited";
};

/** An item Discard closes the items' branches; a whole Discard closes every branch of the draft. No text is reset. */
export type DiscardKernelInput = {
  draftId: DraftId;
  selection: { kind: "items"; items: readonly DiscardItem[] } | { kind: "whole" };
};

export type DiscardKernelResult = {
  draftClosed: boolean;
  tombstoned: readonly NodeRef[];
  /** Storage URLs of tombstoned binaries: deleted after commit, best effort. */
  releasedObjects: readonly string[];
  /** Exactly the branches the transaction closed or deleted: retired after commit. */
  retired: readonly RetiredBranch[];
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
    command?: { envelope: DraftCommandEnvelope; result: DraftCommandOutcome };
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

type CommandClaim = { envelope: DraftCommandEnvelope; result: DraftCommandOutcome };

export function createDraftDiscard(deps: {
  drafts: Pick<Drafts, "byIds">;
  draftLeases: DraftBranchLeases;
  criticalSections: BranchCriticalSections;
  store: DraftDiscardStore;
  /** After commit: the rooms and thread state of exactly the branches the kernel retired. */
  retire: PeerRetirement;
  /** After commit: delete tombstoned binaries' objects, best effort. */
  releaseObjects(storageUrls: readonly string[]): Promise<void>;
}): DraftDiscard {
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

  async function whole(
    workId: WorkId,
    draftId: DraftId,
    command: CommandClaim | undefined,
  ): Promise<DiscardKernelResult | null> {
    return deps.draftLeases.withDraftBranches(draftId, async (_lease, branchIds) => {
      await collabHook("discard.afterLeases");
      return deps.store.discardLocked({
        workId,
        kernel: { draftId, selection: { kind: "whole" } },
        leased: new Set(branchIds),
        ...(command ? { command } : {}),
      });
    });
  }

  async function items(
    workId: WorkId,
    draftId: DraftId,
    selected: readonly DiscardItem[],
    command: CommandClaim | undefined,
  ): Promise<DiscardKernelResult | null> {
    const documentIds = selected.map((item) => item.documentId);
    const branches = await deps.store.activeBranches(draftId, documentIds);
    const branchIds = branches.map((ref) => ref.branchId);
    return deps.criticalSections.withBranches(branchIds, async () => {
      await collabHook("discard.afterLeases");
      return deps.store.discardLocked({
        workId,
        kernel: { draftId, selection: { kind: "items", items: selected } },
        leased: new Set(branchIds),
        ...(command ? { command } : {}),
      });
    });
  }

  return {
    async discardItems(input) {
      const { draftId, workId } = input;
      const gone = { status: "gone" as const, draftId };
      const [draft] = await deps.drafts.byIds([draftId]);
      if (draft?.status !== "active" || draft.originWorkId !== workId) return gone;

      if (input.selection.kind === "whole") {
        const ended = await retrying(() => whole(workId, draftId, input.command));
        if (!ended) return gone;
        await collabHook("discard.beforeRetirement");
        await deps.retire(ended.retired);
        await deps.releaseObjects(ended.releasedObjects);
        return { status: "discarded", draftId, draftClosed: true };
      }

      const selected = input.selection.items;
      if (selected.length === 0) return { status: "discarded", draftId, draftClosed: false };
      const ended = await retrying(() => items(workId, draftId, selected, input.command));
      if (!ended) return gone;
      await collabHook("discard.beforeRetirement");
      await deps.retire(ended.retired);
      await deps.releaseObjects(ended.releasedObjects);
      return { status: "discarded", draftId, draftClosed: false };
    },
  };
}
