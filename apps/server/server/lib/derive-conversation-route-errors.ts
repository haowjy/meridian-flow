/** HTTP status mapping for typed conversation-derivation domain failures. */
import { AgentSelectionError } from "../domains/packages/index.js";
import {
  DerivedSourceNotFoundError,
  ForkCutoffError,
  ForkThreadConflictError,
  SubagentDerivationError,
} from "../domains/threads/index.js";

export function deriveConversationErrorStatus(error: unknown): number | null {
  if (error instanceof DerivedSourceNotFoundError) return 404;
  if (
    error instanceof AgentSelectionError ||
    error instanceof SubagentDerivationError ||
    error instanceof ForkCutoffError
  ) {
    return 400;
  }
  if (error instanceof ForkThreadConflictError) return 409;
  return null;
}
