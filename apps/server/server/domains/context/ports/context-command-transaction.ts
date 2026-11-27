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

export type ContextCommandActiveDraft = { id: DraftId };

export type ContextCommandContext = {
  draft: ContextCommandActiveDraft | null;
};

export type ContextCommandScopes =
  | readonly ContextCommandScope[]
  | (() => Promise<readonly ContextCommandScope[]>);

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
