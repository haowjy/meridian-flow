/** Settle a Work's drafted tree records discarded, for chosen items or the whole branch, and close the drafts they end. */
import type { BranchId, UserId } from "@meridian/contracts";
import type { DiscardCommandResult } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import { testHook } from "../../../shared/test-hooks.js";
import type { Branches } from "./branches.js";
import type { DocumentCommandEnvelope } from "./document-commands.js";
import { type Attempt, NO_ATTEMPT_SCOPE, runBoundedAttempts } from "./draft-attempts.js";
import { DraftCasConflictError } from "./draft-store.js";

export type DiscardSelection = { kind: "items"; items: readonly DiscardItem[] } | { kind: "whole" };

export type DiscardResult =
  | { status: "discarded"; branchId: BranchId; branchClosed: true }
  /** `closed`: the selected documents whose item left review (the kernel closed all it held). */
  | { status: "discarded"; branchId: BranchId; branchClosed: false; closed: readonly DocumentId[] }
  | { status: "gone"; branchId: BranchId }
  /** An item's Discard the branch's state no longer allows: nothing ended. */
  | { status: "refused"; branchId: BranchId; reason: DiscardRefusal["refused"] };

export interface BranchDiscard {
  /**
   * The public command: writer and model. Refuses archived and deleted Works; a lineage
   * with no live member can still be discarded, so the writer can always clear it.
   */
  discardItems(input: {
    branchId: BranchId;
    selection: DiscardSelection;
    userId?: UserId;
    /** The writer's command, settled in the kernel's transaction with what it ended. */
    command: {
      envelope: DocumentCommandEnvelope;
      result(ended: DiscardResult): DiscardCommandResult;
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
   * creation only the Work shows always ends whole.
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
  /** The command that settles the tree records; the kernel mints one when none claimed it. */
  commandId?: string;
  branchId: BranchId;
  selection: DiscardSelection;
};

export class BranchDiscardApplicableStateChangedError extends Error {
  constructor() {
    super("The Work has nothing left to discard on this document");
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
  /** The selected documents whose item left review: nothing of the branch remains on them. */
  closed: readonly DocumentId[];
};

/** A final answer from the kernel: the branch's state no longer allows this Discard. */
export type DiscardRefusal = { refused: "stale" | "draft_changed" };

/** The writer's command, settled in the kernel's transaction; null: the branch is not active. */
export type DiscardCommandClaim = {
  envelope: DocumentCommandEnvelope;
  result(ended: DiscardKernelResult | DiscardRefusal | null): DiscardCommandResult;
};

export interface BranchDiscardStore {
  /**
   * `discardItems`' command transaction (§12.2): the claim; the branch's owner, refusing an
   * archived or deleted Work; the branch (null: not active any more); the lists and
   * documents; the kernel inside the Work's pending projection. The kernel's refusals are
   * stored with the command and returned, not thrown.
   */
  discardLocked(input: {
    kernel: DiscardKernelInput;
    command: DiscardCommandClaim;
  }): Promise<DiscardKernelResult | DiscardRefusal | null>;
}

const ATTEMPTS = 4;

type CommandClaim = NonNullable<Parameters<BranchDiscard["discardItems"]>[0]["command"]>;

function discardResult(
  branchId: BranchId,
  selection: DiscardSelection,
  ended: DiscardKernelResult | DiscardRefusal | null,
): DiscardResult {
  if (!ended) return { status: "gone", branchId };
  if ("refused" in ended) return { status: "refused", branchId, reason: ended.refused };
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
}): BranchDiscard {
  /**
   * The locked kernel again when the branch moved: each attempt is one command transaction,
   * and a miss rolls it back past its claim before the next attempt.
   */
  function attempts(
    run: (attempt: Attempt) => Promise<DiscardKernelResult | DiscardRefusal | null>,
  ): Promise<DiscardKernelResult | DiscardRefusal | null> {
    return runBoundedAttempts({
      bound: ATTEMPTS,
      scope: NO_ATTEMPT_SCOPE,
      isMiss: (cause) => cause instanceof DraftCasConflictError,
      run,
      exhausted: (cause) => {
        throw cause;
      },
    });
  }

  /** `discardLocked` as the attempt's one commit scope. */
  async function commitDiscard(
    attempt: Attempt,
    kernel: DiscardKernelInput,
    command: CommandClaim,
  ): Promise<DiscardKernelResult | DiscardRefusal | null> {
    await testHook("discard.beforeCommitScope");
    return attempt.commit(() =>
      deps.store.discardLocked({
        kernel,
        command: {
          envelope: command.envelope,
          result: (ended) =>
            command.result(discardResult(kernel.branchId, kernel.selection, ended)),
        },
      }),
    );
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
      const kernel = {
        userId: input.userId,
        branchId,
        selection,
        commandId: input.command.envelope.commandId,
      };
      const ended = await deps.holdRetirement(() =>
        attempts((attempt) => commitDiscard(attempt, kernel, input.command)),
      );
      return discardResult(branchId, selection, ended);
    },
  };
}
