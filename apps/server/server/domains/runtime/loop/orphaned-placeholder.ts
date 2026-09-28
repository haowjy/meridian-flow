/** Repairs dead run turns through C4's existing orphan-repair lane. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPendingPlaceholder, isTerminalTurnStatus } from "@meridian/contracts/threads";
import { interruptedPlaceholderError } from "../../threads/index.js";
import { finalizeExecution } from "./execution-finalizer.js";

/** Call under the thread lock and the caller's already-held session claim. */
export async function finalizeOrphanedTurns(
  deps: Parameters<typeof finalizeExecution>[0],
  input: { threadId: ThreadId },
): Promise<SavedExecutionReport[]> {
  const reports: SavedExecutionReport[] = [];
  const unsettled = await deps.repos.turns.listUnsettledForThread(input.threadId);
  const thread = await deps.repos.threads.findByIdIncludingDeleted(input.threadId);
  for (const turn of unsettled) {
    if (isTerminalTurnStatus(turn.status)) continue;
    const placeholder = isPendingPlaceholder(turn);
    if (!placeholder && (turn.role !== "assistant" || thread?.kind === "subagent")) continue;
    const completion = await finalizeExecution(deps, {
      threadId: input.threadId,
      turnId: turn.id,
      ...(placeholder ? { reportContent: "empty" as const } : {}),
      cause: {
        kind: "failed",
        reason: "orphaned",
        error: placeholder ? interruptedPlaceholderError(turn) : "This reply was interrupted.",
      },
    });
    if (completion.report) reports.push(completion.report);
  }
  return reports;
}

/** Repairs only C4 placeholders while the child report lane finds its terminal turn. */
export async function finalizeOrphanedPlaceholders(
  deps: Parameters<typeof finalizeExecution>[0],
  input: { threadId: ThreadId },
): Promise<SavedExecutionReport[]> {
  const reports: SavedExecutionReport[] = [];
  const placeholders = await deps.repos.turns.listPendingPlaceholdersForThread(input.threadId);
  for (const placeholder of placeholders) {
    if (!isPendingPlaceholder(placeholder)) continue;
    const completion = await finalizeExecution(deps, {
      threadId: input.threadId,
      turnId: placeholder.id,
      reportContent: "empty",
      cause: {
        kind: "failed",
        reason: "orphaned",
        error: interruptedPlaceholderError(placeholder),
      },
    });
    if (completion.report) reports.push(completion.report);
  }
  return reports;
}
