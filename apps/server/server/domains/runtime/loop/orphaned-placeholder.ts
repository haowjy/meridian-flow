/** Finalizes placeholders whose owning run is known dead by the caller's held claim. */
import type { Turn } from "@meridian/contracts/threads";
import { finalizeExecution } from "./execution-finalizer.js";

export const COMPACTION_PLACEHOLDER_KINDS = [
  "compaction",
] as const satisfies readonly Turn["role"][];

/** Call under the thread lock and the caller's already-held session claim. */
export async function finalizeOrphanedPlaceholder(
  deps: Parameters<typeof finalizeExecution>[0],
  input: {
    threadId: Turn["threadId"];
    placeholderKinds: readonly Turn["role"][];
  },
): Promise<void> {
  const kinds = new Set(input.placeholderKinds);
  if (kinds.size === 0) return;

  const turns = await deps.repos.turns.listByThread(input.threadId);
  const pending = turns.filter((turn) => kinds.has(turn.role) && turn.status === "pending");
  for (const placeholder of pending) {
    const report = await deps.repos.executionReports.findByTurn(input.threadId, placeholder.id);
    await finalizeExecution(deps, {
      threadId: input.threadId,
      turnId: placeholder.id,
      ...(report?.outcome === null ? { executionTurnId: report.executionTurnId } : {}),
      placeholderKinds: input.placeholderKinds,
      reportContent: "empty",
      cause: {
        kind: "failed",
        reason: "orphaned",
        error: "This compaction was interrupted.",
      },
    });
  }
}
