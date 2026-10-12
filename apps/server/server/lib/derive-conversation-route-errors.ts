/** HTTP status mapping for typed conversation-derivation domain failures. */

import { AgentSelectionError } from "../domains/packages/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/index.js";
import {
  DerivedSourceNotFoundError,
  DerivedThreadConflictError,
  ForkCutoffError,
  HandoffInProgressError,
  SubagentDerivationError,
} from "../domains/threads/index.js";

export function deriveConversationErrorStatus(error: unknown): number | null {
  if (error instanceof WorkLifecycleUnavailableError) return 400;
  if (error instanceof DerivedSourceNotFoundError) return 404;
  if (error instanceof AgentSelectionError || error instanceof SubagentDerivationError) {
    return 400;
  }
  if (error instanceof ForkCutoffError) return error.code === "unsettled_history" ? 409 : 400;
  if (error instanceof DerivedThreadConflictError || error instanceof HandoffInProgressError)
    return 409;
  return null;
}
