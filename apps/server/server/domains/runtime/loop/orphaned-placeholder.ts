/** Repairs dead run turns through C4's existing orphan-repair lane. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPendingPlaceholder, isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import { HandoffSeedMetadataCodec, turnFailedCopy } from "../../threads/index.js";
import { completeHandoffSeed, handoffSeedBlock } from "../handoff/seed.js";
import { finalizeExecution } from "./execution-finalizer.js";
import { historyReadableAt } from "./history-tool-availability.js";
import type { PersistenceDeps } from "./persistence.js";

type OrphanRepairDeps = Parameters<typeof finalizeExecution>[0] & {
  publishStatus?(threadId: ThreadId): Promise<void>;
  retireOrphanedReply?(threadId: ThreadId, turnId: Turn["id"]): Promise<void>;
  clearOrphanedTurn?(threadId: ThreadId, turnId: Turn["id"]): Promise<void>;
};

async function finalizeHandoffSeed(deps: OrphanRepairDeps, seed: Turn): Promise<void> {
  if (seed.role !== "system" || !HandoffSeedMetadataCodec.safeParse(seed.metadata).success) return;
  const error = turnFailedCopy(seed);
  const completed: Turn = {
    ...seed,
    status: "error",
    finishReason: "error",
    error,
    completedAt: new Date().toISOString(),
  };
  const historyReadable = await historyReadableAt(
    { repos: deps.repos, toolRegistry: deps.toolRegistry },
    seed,
  );
  await completeHandoffSeed(
    deps as PersistenceDeps,
    completed,
    handoffSeedBlock(seed, undefined, historyReadable),
    { failure: { reason: "interrupted", phase: "recovery" } },
  );
  await deps.publishStatus?.(seed.threadId as ThreadId);
}

/** Call under the thread lock and the caller's already-held session claim. */
export async function finalizeOrphanedTurns(
  deps: OrphanRepairDeps,
  input: { threadId: ThreadId },
): Promise<SavedExecutionReport[]> {
  const reports: SavedExecutionReport[] = [];
  const unsettled = await deps.repos.turns.listUnsettledForThread(input.threadId);
  const thread = await deps.repos.threads.findByIdIncludingDeleted(input.threadId);
  for (const turn of unsettled) {
    if (isTerminalTurnStatus(turn.status)) continue;
    const placeholder = isPendingPlaceholder(turn);
    if (placeholder && turn.role === "system") {
      await finalizeHandoffSeed(deps, turn);
      await deps.clearOrphanedTurn?.(input.threadId, turn.id);
      continue;
    }
    const compaction = placeholder && turn.role === "compaction";
    if (!compaction && (turn.role !== "assistant" || thread?.kind === "subagent")) continue;
    const completion = await finalizeExecution(deps, {
      threadId: input.threadId,
      turnId: turn.id,
      ...(compaction ? { reportContent: "empty" as const } : {}),
      cause: {
        kind: "failed",
        reason: "orphaned",
        error: turnFailedCopy(turn),
      },
    });
    if (compaction) await deps.clearOrphanedTurn?.(input.threadId, turn.id);
    else await deps.retireOrphanedReply?.(input.threadId, turn.id);
    if (completion.report) reports.push(completion.report);
  }
  return reports;
}

/** Repairs only C4 placeholders while the child report lane finds its terminal turn. */
export async function finalizeOrphanedPlaceholders(
  deps: OrphanRepairDeps,
  input: { threadId: ThreadId },
): Promise<SavedExecutionReport[]> {
  const reports: SavedExecutionReport[] = [];
  const placeholders = await deps.repos.turns.listPendingPlaceholdersForThread(input.threadId);
  for (const placeholder of placeholders) {
    if (!isPendingPlaceholder(placeholder)) continue;
    if (placeholder.role !== "compaction") continue;
    const completion = await finalizeExecution(deps, {
      threadId: input.threadId,
      turnId: placeholder.id,
      reportContent: "empty",
      cause: {
        kind: "failed",
        reason: "orphaned",
        error: turnFailedCopy(placeholder),
      },
    });
    await deps.clearOrphanedTurn?.(input.threadId, placeholder.id);
    if (completion.report) reports.push(completion.report);
  }
  return reports;
}
