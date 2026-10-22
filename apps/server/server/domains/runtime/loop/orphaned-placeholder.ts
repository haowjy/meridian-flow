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

const isExecutionTurn = (turn: Turn) => turn.role === "assistant" || turn.role === "compaction";

/**
 * What a repair may take. `sweep` is the primary lane: seeds, compaction placeholders and the
 * chat's own assistants, never a subagent's. `claimed` is for a caller that has just taken a
 * stale execution's claim, which proves every unsettled assistant or compaction turn is an
 * orphan: it adds a subagent's assistant and a compaction that is no longer a placeholder.
 */
export type OrphanRepairScope = "sweep" | "claimed";

/** Call under the thread lock and the caller's already-held session claim. */
export async function finalizeOrphanedTurns(
  deps: OrphanRepairDeps,
  input: { threadId: ThreadId; roles?: readonly Turn["role"][]; scope?: OrphanRepairScope },
): Promise<SavedExecutionReport[]> {
  const reports: SavedExecutionReport[] = [];
  const unsettled = await deps.repos.turns.listUnsettledForThread(input.threadId);
  const thread = await deps.repos.threads.findByIdIncludingDeleted(input.threadId);
  for (const turn of unsettled) {
    if (input.roles && !input.roles.includes(turn.role)) continue;
    if (isTerminalTurnStatus(turn.status)) continue;
    const placeholder = isPendingPlaceholder(turn);
    if (placeholder && turn.role === "system") {
      await finalizeHandoffSeed(deps, turn);
      await deps.clearOrphanedTurn?.(input.threadId, turn.id);
      continue;
    }
    const sweeps =
      (placeholder && turn.role === "compaction") ||
      (turn.role === "assistant" && thread?.kind !== "subagent");
    if (!sweeps && (input.scope !== "claimed" || !isExecutionTurn(turn))) continue;
    const compaction = turn.role === "compaction";
    const completion = await finalizeExecution(deps, {
      threadId: input.threadId,
      turnId: turn.id,
      ...(compaction ? { reportContent: "empty" as const } : {}),
      cause: {
        kind: "failed",
        reason: "orphaned",
        error: sweeps
          ? "Run stopped before terminal completion"
          : "Child execution stopped before terminal completion",
      },
    });
    if (compaction) await deps.clearOrphanedTurn?.(input.threadId, turn.id);
    else await deps.retireOrphanedReply?.(input.threadId, turn.id);
    if (completion.report) reports.push(completion.report);
  }
  return reports;
}
