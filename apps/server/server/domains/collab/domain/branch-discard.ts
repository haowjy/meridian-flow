/** End a hidden creation's branch use, or close a whole Work branch, with post-commit retirement. */
import type { BranchId, UserId } from "@meridian/contracts";
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
  | { status: "discarded"; branchId: BranchId; branchClosed: true }
  /** `closed`: the selected documents whose item left review (the kernel closed all it held). */
  | { status: "discarded"; branchId: BranchId; branchClosed: false; closed: readonly DocumentId[] }
  | { status: "gone"; branchId: BranchId };

export interface BranchDiscard {
  /**
   * The public command: writer and model. Refuses archived and deleted Works; a lineage
   * with no live member can still be discarded, so the writer can always clear it.
   */
  discardItems(input: {
    branchId: BranchId;
    selection: DiscardSelection;
    userId?: UserId;
    /** The writer's command, settled `done` in the kernel's transaction with what it ended (§4.6). */
    command?: {
      envelope: BranchCommandEnvelope;
      result(ended: DiscardResult): BranchCommandResult;
    };
  }): Promise<DiscardResult>;
}

/** One selected item as the kernel ends it. */
export type DiscardItem = {
  documentId: DocumentId;
  /** Provenance only: the kernel classifies by the document's visibility under its locks (§2.2). */
  origin: "created" | "edited";
  /**
   * What ends: `tree`, only the branch's move or delete (a live chat's Discard, whose text the
   * writer reverts in the room), or `item`, everything the branch holds on the document. A
   * hidden creation always ends whole.
   */
  ends: "tree" | "item";
  /**
   * For `item`: the text draft's `updated_at` as the writer saw it (ISO; null, no text draft).
   * A draft that moved on refuses the Discard (`BranchDiscardDraftChangedError`). Absent: no fence.
   */
  draftSeenAt?: string | null;
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

/** The item's text draft is not the one the writer saw: nothing ended. */
export class BranchDiscardDraftChangedError extends Error {
  constructor() {
    super("This draft changed since the writer saw it");
    this.name = "BranchDiscardDraftChangedError";
  }
}

export type DiscardKernelResult = {
  /** Storage URLs of tombstoned binaries: deleted after commit, best effort. */
  releasedObjects: readonly string[];
  /** The selected documents whose item left review: nothing of the branch remains on them. */
  closed: readonly DocumentId[];
};

/** The writer's command, settled in the kernel's transaction; null: the branch is not active. */
export type DiscardCommandClaim = {
  envelope: BranchCommandEnvelope;
  result(ended: DiscardKernelResult | null): BranchCommandResult;
};

export interface BranchDiscardStore {
  /**
   * `discardItems`' transaction (§12.2): the branch's owner, refusing an archived or deleted Work;
   * the branch (null: not active any more); the namespaces and documents; the kernel inside
   * the Work's pending projection.
   */
  discardLocked(input: {
    kernel: DiscardKernelInput;
    command?: DiscardCommandClaim;
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

type CommandClaim = NonNullable<Parameters<BranchDiscard["discardItems"]>[0]["command"]>;

function discardResult(
  branchId: BranchId,
  selection: DiscardSelection,
  ended: DiscardKernelResult | null,
): DiscardResult {
  if (!ended) return { status: "gone", branchId };
  return selection.kind === "whole"
    ? { status: "discarded", branchId, branchClosed: true }
    : { status: "discarded", branchId, branchClosed: false, closed: ended.closed };
}

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
    kernel: DiscardKernelInput,
    command: CommandClaim | undefined,
  ): Promise<DiscardKernelResult | null> {
    await testHook("discard.beforeCommitScope");
    return attempt.commit(async () => {
      const ended = await deps.store.discardLocked({
        kernel,
        ...(command
          ? {
              command: {
                envelope: command.envelope,
                result: (ended) =>
                  command.result(discardResult(kernel.branchId, kernel.selection, ended)),
              },
            }
          : {}),
      });
      if (ended && !deps.store.deferUntilCommit(() => deps.releaseObjects(ended.releasedObjects)))
        throw new Error("Discard must run inside its attempt's transaction");
      return ended;
    });
  }

  return {
    async discardItems(input) {
      const { branchId } = input;
      const gone = { status: "gone" as const, branchId };
      const [branch] = await deps.branches.byIds([branchId]);
      if (branch?.status !== "active") return gone;

      const { selection } = input;
      if (selection.kind === "items" && selection.items.length === 0)
        return { status: "discarded", branchId, branchClosed: false, closed: [] };
      const kernel = { userId: input.userId, branchId, selection };
      const ended = await deps.holdRetirement(() =>
        attempts((attempt) => commitDiscard(attempt, kernel, input.command)),
      );
      return discardResult(branchId, selection, ended);
    },
  };
}
