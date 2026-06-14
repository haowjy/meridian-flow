// @ts-nocheck
/**
 * composer-agent-mode — freeze-gate for the composer agent picker.
 *
 * The picker is interactive only while the next send can still bind the agent
 * (optimistic thread, server row not confirmed, no turns yet). Once the server
 * thread exists or an agent slug is bound, the chip is readonly.
 */

export function resolveComposerAgentMode(args: {
  /** Optimistic create still in flight — server row may not exist yet. */
  isPendingServerCreate: boolean;
  /** Thread row is present in client state (optimistic or server). */
  hasActiveThread: boolean;
  /** Bound agent slug from the thread row; null until bound. */
  currentAgent: string | null | undefined;
  /** Authoritative turn count from the thread list / snapshot. */
  turnCount: number;
  /** Local in-memory turns for this thread (optimistic user append). */
  localTurnCount: number;
}): "interactive" | "readonly" {
  const threadStarted = args.turnCount > 0 || args.localTurnCount > 0;
  if (threadStarted) return "readonly";
  if (args.currentAgent != null) return "readonly";
  if (args.hasActiveThread && !args.isPendingServerCreate) return "readonly";
  return "interactive";
}
