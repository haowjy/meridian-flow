import type { DraftId, WorkId } from "@meridian/contracts";
import type { ContextScheme } from "./context-port.js";

export type ContextCommandScope = { scheme: ContextScheme; workId: string | null };

/**
 * A command that writes a draft-mode Work's draft (contract §2.3): the transaction locks
 * that Work with its other Works, then the Work's active draft (made at this write
 * boundary for `ensure`, only locked for `existing`), before any namespace lock.
 */
export type ContextCommandDraft = {
  mode: "ensure" | "existing";
  workId: string;
  threadId: string;
  userId: string;
};

export type ContextCommandOptions = {
  draft?: ContextCommandDraft;
  /** More sources whose namespaces the command takes with its own, in key order (§6.4). */
  sourceIds?: readonly string[];
};

/** What the transaction resolved before the command ran. */
export type ContextCommandContext = {
  /** The locked active draft, when the command asked for one; null when none is active. */
  draft: { id: DraftId; originWorkId: WorkId | null } | null;
};

/** Transaction boundary for one result-returning Context command. */
export interface ContextCommandTransaction {
  run<T>(
    operation: (command: ContextCommandContext) => Promise<T>,
    scopes?: readonly ContextCommandScope[],
    options?: ContextCommandOptions,
  ): Promise<T>;
}

export const directContextCommandTransaction: ContextCommandTransaction = {
  run: (operation) => operation({ draft: null }),
};
