import type { DraftId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { ContextScheme } from "./context-port.js";

export type ContextCommandScope = { scheme: ContextScheme; workId: string | null };

/**
 * A command that writes a draft-mode Work's draft (contract §2.3): the transaction locks
 * that Work with its other Works, then the Work's active draft (made at this write
 * boundary for `ensure`, only locked for `existing`), before any namespace lock.
 */
export type ContextCommandDraft = {
  mode: "ensure" | "existing";
  workId: WorkId;
  threadId: ThreadId;
  userId: UserId;
};

export type ContextCommandOptions = {
  draft?: ContextCommandDraft;
  /** More sources whose namespaces the command takes with its own, in key order (§6.4). */
  sourceIds?: readonly string[];
};

/** A locked active draft as the transaction resolved it. */
export type ContextCommandActiveDraft = { id: DraftId; originWorkId: WorkId | null };

/** What the transaction resolved before the command ran. */
export type ContextCommandContext = {
  /**
   * The locked active draft, when the command asked for one; null when none is active.
   * An `ensure` command always has one (the transaction makes it).
   */
  draft: ContextCommandActiveDraft | null;
};

/** Scopes known up front, or resolved when the transaction starts (an identity destination's current home). */
export type ContextCommandScopes =
  | readonly ContextCommandScope[]
  | (() => Promise<readonly ContextCommandScope[]>);

/** Transaction boundary for one result-returning Context command. */
export interface ContextCommandTransaction {
  run<T>(
    operation: (command: ContextCommandContext) => Promise<T>,
    scopes?: ContextCommandScopes,
    options?: ContextCommandOptions,
  ): Promise<T>;
}

export const directContextCommandTransaction: ContextCommandTransaction = {
  async run(operation, scopes) {
    if (typeof scopes === "function") await scopes();
    return operation({ draft: null });
  },
};
