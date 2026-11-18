/** Settle a Work's drafted tree records discarded, for chosen items or the whole branch, and close the drafts they end. */
import type { BranchId, UserId } from "@meridian/contracts";
import type { DiscardCommandResult } from "@meridian/contracts/branches";
import type { Settlement } from "@meridian/contracts/commands";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { testHook } from "../../../shared/test-hooks.js";
import { type Attempt, NO_ATTEMPT_SCOPE, runBoundedAttempts } from "./draft-attempts.js";
import { DraftCasConflictError } from "./draft-store.js";

export type DiscardSelection = { kind: "items"; items: readonly DiscardItem[] } | { kind: "whole" };

/**
 * What a Discard ended with, whatever it found: `closed` the selected documents whose item left
 * review (the kernel closed all it held, or an earlier command already had), `settled` what
 * became of the items this command did not take, and `branchClosed` for Discard all.
 */
export type DiscardResult = {
  branchId: BranchId;
  branchClosed: boolean;
  closed: readonly DocumentId[];
  settled: Settlement[];
};

export interface BranchDiscard {
  /**
   * The public command: writer and model. On drafts whose owner is closed (an archived or
   * deleted Work, a chat in Trash) it stores a `returned` bounce and ends nothing.
   */
  discardItems(input: {
    branchId: BranchId;
    selection: DiscardSelection;
    userId?: UserId;
    /** The writer's command, settled in the kernel's transaction with what it ended. */
    command: {
      envelope: CommandEnvelope;
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
};

export type DiscardKernelInput = {
  userId?: UserId;
  /** The command that settles the tree records; the kernel mints one when none claimed it. */
  commandId?: string;
  branchId: BranchId;
  selection: DiscardSelection;
};

export type DiscardKernelResult = {
  /** The selected documents whose item left review: nothing of the branch remains on them. */
  closed: readonly DocumentId[];
  /**
   * One line per item this command did not take, from the settlement reader: `already
   * discarded`, or `overtaken` by an Apply. Discard all on a closed branch: one `already`.
   */
  settled: Settlement[];
};

/** A final answer from the Work lock: the drafts' owner is closed, and nothing ended. */
export type DiscardReturned = { returned: Settlement[] };

/** What a Discard transaction ended with. */
export type DiscardEnded = DiscardKernelResult | DiscardReturned;

/** The writer's command, settled in the kernel's transaction. */
export type DiscardCommandClaim = {
  envelope: CommandEnvelope;
  result(ended: DiscardEnded): DiscardCommandResult;
};

export interface BranchDiscardStore {
  /**
   * `discardItems`' command transaction (§12.2): the claim; the branch's owner, refusing an
   * archived or deleted Work, which stores a `returned` bounce; the branch; the lists and
   * documents; the kernel inside the Work's pending projection. A branch no longer active
   * takes nothing, and its items are answered by the settlement reader all the same.
   */
  discardLocked(input: {
    kernel: DiscardKernelInput;
    command: DiscardCommandClaim;
  }): Promise<DiscardEnded>;
}

const ATTEMPTS = 4;

type CommandClaim = NonNullable<Parameters<BranchDiscard["discardItems"]>[0]["command"]>;

function discardResult(
  branchId: BranchId,
  selection: DiscardSelection,
  ended: DiscardEnded,
): DiscardResult {
  if ("returned" in ended)
    return { branchId, branchClosed: false, closed: [], settled: ended.returned };
  return {
    branchId,
    branchClosed: selection.kind === "whole",
    closed: ended.closed,
    settled: ended.settled,
  };
}

export function createBranchDiscard(deps: {
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
  function attempts(run: (attempt: Attempt) => Promise<DiscardEnded>): Promise<DiscardEnded> {
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
  ): Promise<DiscardEnded> {
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
      const { branchId, selection } = input;
      if (selection.kind === "items" && selection.items.length === 0)
        return discardResult(branchId, selection, { closed: [], settled: [] });
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
