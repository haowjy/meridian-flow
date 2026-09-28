/** Finalizes placeholders whose owning run is known dead by the caller's held claim. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPendingPlaceholder } from "@meridian/contracts/threads";
import { interruptedPlaceholderError } from "../../threads/index.js";
import { finalizeExecution } from "./execution-finalizer.js";

/** Call under the thread lock and the caller's already-held session claim. */
export async function finalizeOrphanedPlaceholder(
  deps: Parameters<typeof finalizeExecution>[0] & {
    inbox: Pick<import("./ports.js").InboxReader, "selectPending">;
  },
  input: { threadId: ThreadId },
): Promise<SavedExecutionReport[]> {
  const reports: SavedExecutionReport[] = [];
  const pending = await deps.repos.turns.listPendingPlaceholdersForThread(input.threadId);
  const pendingControls = await deps.inbox.selectPending(input.threadId);
  for (const placeholder of pending) {
    if (!isPendingPlaceholder(placeholder)) continue;
    if (
      pendingControls.some(
        (row) =>
          row.intent === "control" &&
          row.body.kind === "handoff_brief" &&
          row.body.seedTurnId === placeholder.id,
      )
    )
      continue;
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
