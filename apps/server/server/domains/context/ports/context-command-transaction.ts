import type { DraftId, DraftOwner, ThreadId, UserId } from "@meridian/contracts";
import type { ContextScheme } from "./context-port.js";

export type ContextCommandScope = { scheme: ContextScheme; workId: string | null };

/**
 * A command that writes an owner's draft for a draft-mode chat (contract §2.3): the transaction
 * locks that owner with its other Works, then its draft (refusing a closed owner, as for any new
 * AI write), before any namespace lock.
 */
export type ContextCommandDraft = {
  owner: DraftOwner;
  draftId: DraftId;
  threadId: ThreadId | null;
  userId: UserId;
};

export type ContextCommandOptions = {
  draft?: ContextCommandDraft;
  /** More sources whose namespaces the command takes with its own, in key order (§6.4). */
  sourceIds?: readonly string[];
};

/** A locked draft as the transaction resolved it. */
export type ContextCommandActiveDraft = { id: DraftId };

/** What the transaction resolved before the command ran. */
export type ContextCommandContext = {
  /** The locked draft, when the command asked for one. */
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
