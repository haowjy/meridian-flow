/** End a hidden creation's branch use, or close a whole Work branch, with post-commit retirement. */
import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type { BranchCommandResult } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import { testHook } from "../../../shared/test-hooks.js";
import type { BranchCommandEnvelope } from "./branch-commands.js";
import type { Branches } from "./branches.js";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./draft-attempts.js";
import { DraftCasConflictError } from "./draft-store.js";

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

export type DiscardKernelInput = {
  userId?: UserId;
  branchId: BranchId;
  selection: DiscardSelection;
};

export class BranchDiscardApplicableStateChangedError extends Error {
  constructor() {
    super("This document is no longer a hidden creation");
    this.name = "BranchDiscardApplicableStateChangedError";
  }
}

export type DiscardKernelResult = {
  /** Storage URLs of tombstoned binaries: deleted after commit, best effort. */
  releasedObjects: readonly string[];
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
  store: BranchDiscardStore;
  /**
   * Runs the Discard, holding back the retirement of the drafts its commit closed until it
   * leaves its live scopes: a root the Discard opened commits while they are held, and a save
   * racing the retirement may need them.
   */
  holdRetirement<T>(run: () => Promise<T>): Promise<T>;
  /** After commit: delete tombstoned binaries' objects, best effort. */
  releaseObjects(storageUrls: readonly string[]): Promise<void>;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
}): BranchDiscard {
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

  /** `discardLocked` in the attempt's scope, its objects released once that transaction commits. */
  async function commitDiscard(
    attempt: Attempt,
    input: Parameters<BranchDiscardStore["discardLocked"]>[0],
  ): Promise<DiscardKernelResult | null> {
    await testHook("discard.beforeCommitScope");
    return attempt.commit(async () => {
      const ended = await deps.store.discardLocked(input);
      if (ended && !deps.store.deferUntilCommit(() => deps.releaseObjects(ended.releasedObjects)))
        throw new Error("Discard must run inside its attempt's transaction");
      return ended;
    });
  }

  function whole(
    attempt: Attempt,
    workId: WorkId,
    branchId: BranchId,
    command: CommandClaim | undefined,
    userId: UserId | undefined,
  ): Promise<DiscardKernelResult | null> {
    return commitDiscard(attempt, {
      workId,
      kernel: { userId, branchId, selection: { kind: "whole" } },
      ...(command ? { command } : {}),
    });
  }

  function items(
    attempt: Attempt,
    workId: WorkId,
    branchId: BranchId,
    selected: readonly DiscardItem[],
    command: CommandClaim | undefined,
    userId: UserId | undefined,
  ): Promise<DiscardKernelResult | null> {
    return commitDiscard(attempt, {
      workId,
      kernel: { userId, branchId, selection: { kind: "items", items: selected } },
      ...(command ? { command } : {}),
    });
  }

  return {
    async discardItems(input) {
      const { branchId, workId } = input;
      const gone = { status: "gone" as const, branchId };
      const [branch] = await deps.branches.byIds([branchId]);
      if (branch?.status !== "active" || branch.originWorkId !== workId) return gone;

      if (input.selection.kind === "whole") {
        const ended = await deps.holdRetirement(() =>
          attempts((attempt) => whole(attempt, workId, branchId, input.command, input.userId)),
        );
        return ended ? { status: "discarded", branchId, branchClosed: true } : gone;
      }

      const selected = input.selection.items;
      if (selected.length === 0) return { status: "discarded", branchId, branchClosed: false };
      const ended = await deps.holdRetirement(() =>
        attempts((attempt) =>
          items(attempt, workId, branchId, selected, input.command, input.userId),
        ),
      );
      return ended ? { status: "discarded", branchId, branchClosed: false } : gone;
    },
  };
}
