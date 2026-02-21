import { ErrorType, isAppError } from "@/core/lib/errors";

export type RetrievalOperationKey =
  | "document:getById"
  | "skill:getById"
  | "thread:getById"
  | "project:getById";

export type TerminalErrorAction =
  | "prune_local_entity"
  | "clear_active_selection"
  | "keep_local_state";

type RetrievalOperationPolicy = Partial<Record<ErrorType, TerminalErrorAction>>;

const TERMINAL_ERROR_POLICIES: Record<
  RetrievalOperationKey,
  RetrievalOperationPolicy
> = {
  // Server truth: if a direct document-by-id fetch is gone, prune stale local cache/state.
  "document:getById": {
    [ErrorType.NotFound]: "prune_local_entity",
  },
  // For non-cached selection views, stale IDs should be cleared, not locally deleted.
  "skill:getById": {
    [ErrorType.NotFound]: "clear_active_selection",
  },
  "thread:getById": {
    [ErrorType.NotFound]: "clear_active_selection",
  },
  "project:getById": {
    [ErrorType.NotFound]: "clear_active_selection",
  },
};

export function getTerminalErrorAction(
  operation: RetrievalOperationKey,
  error: unknown,
): TerminalErrorAction {
  if (!isAppError(error)) return "keep_local_state";
  return TERMINAL_ERROR_POLICIES[operation][error.type] ?? "keep_local_state";
}

export function shouldPruneLocalEntity(
  operation: RetrievalOperationKey,
  error: unknown,
): boolean {
  return getTerminalErrorAction(operation, error) === "prune_local_entity";
}

export function shouldClearActiveSelection(
  operation: RetrievalOperationKey,
  error: unknown,
): boolean {
  return getTerminalErrorAction(operation, error) === "clear_active_selection";
}
