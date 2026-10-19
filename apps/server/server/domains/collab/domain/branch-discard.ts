/**
 * Discard (contract §12): one kernel for one item, the whole branch and Work purge. The
 * public command `discardItems` (writer and model) holds no draft: an item Discard
 * holds its items' live documents (the live scope it resets from), then each attempt runs
 * the store's one transaction: the Work, active (D30), the branch, the namespaces and
 * documents, and the kernel. The kernel resets each item's text from live, folding away
 * every frame that landed before it (a writer's frame then misses its revision), or closes
 * every draft with the branch, and ends the branch's use of what it created: what no branch
 * uses any more is tombstoned and its storage released. Rooms, thread peers and objects
 * are retired once the transaction's root commits. Purge runs the kernel in its own
 * transaction after its own lifecycle proof (§2.6).
 */
import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type { BranchCommandResult } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { NodeRef } from "../../context/tree/tree-view.js";
import type { BranchCommandEnvelope } from "./branch-commands.js";
import type { Branches } from "./branches.js";
import { collabHook } from "./collab-test-hooks.js";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./draft-attempts.js";
import { DraftCasConflictError } from "./draft-store.js";
import type { PeerRetirement, RetiredDraft } from "./peer-retirement.js";

export type DiscardSelection = { kind: "items"; items: readonly DiscardItem[] } | { kind: "whole" };

export type DiscardResult =
  | { status: "discarded"; branchId: BranchId; branchClosed: boolean }
  | { status: "gone"; branchId: BranchId };

export interface BranchDiscard {
  /** The public command: writer and model. Refuses archived and deleted Works (D30). */
  discardItems(input: {
    workId: WorkId;
    branchId: BranchId;
    selection: DiscardSelection;
    userId?: UserId;
    /** The writer's command, claimed `done` in the kernel's transaction with this result (§4.6). */
    command?: { envelope: BranchCommandEnvelope; result: BranchCommandResult };
  }): Promise<DiscardResult>;
}

/** One selected item as the kernel ends it. */
export type DiscardItem = {
  documentId: DocumentId;
  /** The branch's draft on it; null for a created image. */
  draftId: string | null;
  /** Provenance only: the kernel classifies by the document's visibility under its locks (§2.2). */
  origin: "created" | "edited";
};

export type DiscardKernelInput = { userId?: UserId } /**
 * Item text resets need the live documents they reset from, and the attempt that owns
 * each reset until it completes.
 */ & (
  | {
      branchId: BranchId;
      selection: { kind: "items"; items: readonly DiscardItem[] };
      liveDocs: ReadonlyMap<DocumentId, Y.Doc>;
      attempt: Attempt;
    }
  /** A whole Discard closes every draft and resets no text (purge passes this). */
  | { branchId: BranchId; selection: { kind: "whole" } }
);

export type DiscardKernelResult = {
  branchClosed: boolean;
  tombstoned: readonly NodeRef[];
  /** Storage URLs of tombstoned binaries: deleted after commit, best effort. */
  releasedObjects: readonly string[];
  /** Exactly the drafts the transaction closed or deleted: retired after commit. */
  retired: readonly RetiredDraft[];
};

export interface BranchDiscardStore {
  /**
   * `discardItems`' transaction (§12.2): the Work, refusing an archived or deleted one;
   * the branch (null: not active any more); the namespaces and documents; the kernel inside
   * the Work's pending projection.
   */
  discardLocked(input: {
    workId: WorkId;
    kernel: DiscardKernelInput;
    command?: { envelope: BranchCommandEnvelope; result: BranchCommandResult };
  }): Promise<DiscardKernelResult | null>;
  /**
   * Runs `callback` once the ambient transaction's root commits, never after a rollback
   * (a savepoint's rolls back with it); false, with nothing deferred, outside a transaction.
   */
  deferUntilCommit(callback: () => Promise<void>): boolean;
}

/** One of the branch's created documents moved to another source before the locks: run again. */
export class BranchDiscardScopeChangedError extends Error {
  constructor(readonly branchId: BranchId) {
    super(`Branch ${branchId} changed while its Discard was taking its locks`);
    this.name = "BranchDiscardScopeChangedError";
  }
}

const ATTEMPTS = 4;

type CommandClaim = { envelope: BranchCommandEnvelope; result: BranchCommandResult };

export function createBranchDiscard(deps: {
  branches: Pick<Branches, "byIds">;
  liveCoordinator: {
    withDocument<T>(documentId: string, run: (doc: Y.Doc) => Promise<T>): Promise<T>;
  };
  store: BranchDiscardStore;
  /** After commit: the rooms and thread state of exactly the drafts the kernel retired. */
  retire: PeerRetirement;
  /** After commit: delete tombstoned binaries' objects, best effort. */
  releaseObjects(storageUrls: readonly string[]): Promise<void>;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
}): BranchDiscard {
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

  /**
   * The locked kernel again when the branch moved: each attempt's commit scope opens inside
   * the live scopes it took (process-level locks before the database's), and a miss leaves
   * it before the next attempt. The after-commit effects of exactly what the kernel ended
   * are registered on the attempt's transaction, so they run once its root commits.
   */
  function attempts(
    run: (attempt: Attempt) => Promise<DiscardKernelResult | null>,
  ): Promise<DiscardKernelResult | null> {
    return runBoundedAttempts({
      bound: ATTEMPTS,
      scope: deps.attemptScope ?? NO_ATTEMPT_SCOPE,
      isMiss: (cause) =>
        cause instanceof DraftCasConflictError || cause instanceof BranchDiscardScopeChangedError,
      run,
      exhausted: (cause) => {
        throw cause;
      },
    });
  }

  /**
   * The retirement of what a committed Discard ended: rooms, thread peers and objects. It
   * runs once the attempt's root transaction commits and never after a rollback (a missed
   * attempt's registration rolls back with its savepoint), and never inside the Discard's
   * own live scopes: a root the Discard opened commits while they are held, so its commit
   * only marks the effects ready and they run when the Discard returns; an ambient root
   * still open then runs them at its own commit.
   */
  function afterRootCommit() {
    let returned = false;
    let ready: (() => Promise<void>) | null = null;
    return {
      register(ended: DiscardKernelResult) {
        const effects = async () => {
          await collabHook("discard.beforeRetirement");
          await deps.retire(ended.retired);
          await deps.releaseObjects(ended.releasedObjects);
        };
        const deferred = deps.store.deferUntilCommit(async () => {
          if (returned) await effects();
          else ready = effects;
        });
        if (!deferred) throw new Error("Discard must run inside its attempt's transaction");
      },
      async returned() {
        returned = true;
        const effects = ready;
        ready = null;
        await effects?.();
      },
    };
  }

  type AfterRootCommit = ReturnType<typeof afterRootCommit>;

  /** `discardLocked` in the attempt's scope, its retirement registered on that transaction. */
  async function commitDiscard(
    attempt: Attempt,
    after: AfterRootCommit,
    input: Parameters<BranchDiscardStore["discardLocked"]>[0],
  ): Promise<DiscardKernelResult | null> {
    await collabHook("discard.beforeCommitScope");
    return attempt.commit(async () => {
      const ended = await deps.store.discardLocked(input);
      if (ended) after.register(ended);
      return ended;
    });
  }

  function whole(
    attempt: Attempt,
    after: AfterRootCommit,
    workId: WorkId,
    branchId: BranchId,
    command: CommandClaim | undefined,
    userId: UserId | undefined,
  ): Promise<DiscardKernelResult | null> {
    return commitDiscard(attempt, after, {
      workId,
      kernel: { userId, branchId, selection: { kind: "whole" } },
      ...(command ? { command } : {}),
    });
  }

  function items(
    attempt: Attempt,
    after: AfterRootCommit,
    workId: WorkId,
    branchId: BranchId,
    selected: readonly DiscardItem[],
    command: CommandClaim | undefined,
    userId: UserId | undefined,
  ): Promise<DiscardKernelResult | null> {
    const textDocuments = selected.flatMap((item) => (item.draftId ? [item.documentId] : []));
    return withLiveDocuments(textDocuments, (liveDocs) =>
      commitDiscard(attempt, after, {
        workId,
        kernel: {
          userId,
          branchId,
          selection: { kind: "items", items: selected },
          liveDocs,
          attempt,
        },
        ...(command ? { command } : {}),
      }),
    );
  }

  return {
    async discardItems(input) {
      const { branchId, workId } = input;
      const gone = { status: "gone" as const, branchId };
      const [branch] = await deps.branches.byIds([branchId]);
      if (branch?.status !== "active" || branch.originWorkId !== workId) return gone;

      const after = afterRootCommit();
      if (input.selection.kind === "whole") {
        const ended = await attempts((attempt) =>
          whole(attempt, after, workId, branchId, input.command, input.userId),
        );
        await after.returned();
        return ended ? { status: "discarded", branchId, branchClosed: true } : gone;
      }

      const selected = input.selection.items;
      if (selected.length === 0) return { status: "discarded", branchId, branchClosed: false };
      const ended = await attempts((attempt) =>
        items(attempt, after, workId, branchId, selected, input.command, input.userId),
      );
      await after.returned();
      return ended ? { status: "discarded", branchId, branchClosed: false } : gone;
    },
  };
}
