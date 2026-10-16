/**
 * Where a failed turn becomes a `FailureRecord`. `projectAndAppendEvents` calls it for every live durable
 * event, inside the transaction that persists the event, so one seam covers every terminal writer (the
 * execution finalizer, compaction completion, handoff seeds, orphan repair) and every end (a Retry or a
 * move-on forgetting the attempt, a pass that keeps it). Records ride the writer's `recordFailure`, which
 * emits after the outermost commit.
 */
import {
  classifyReplyFailure,
  type Failure,
  type FailureRecord,
} from "@meridian/contracts/failures";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import { latestRowAt } from "./latest-row.js";
import type { PersistenceDeps } from "./persistence.js";

type Detector = Pick<PersistenceDeps, "repos" | "eventWriter">;

/** The failure a settled failed turn carries: its typed reason, the error code it settled with, and the provider's status. */
export function failureOfTurn(turn: Turn, errorCode?: string): Failure {
  const metadata =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? turn.metadata
      : {};
  const providerError = metadata.providerError;
  const status =
    providerError && typeof providerError === "object" && !Array.isArray(providerError)
      ? providerError.status
      : undefined;
  return classifyReplyFailure({
    reason: typeof metadata.reason === "string" ? metadata.reason : null,
    code: errorCode ?? null,
    status: typeof status === "number" ? status : null,
  });
}

function base(turn: Turn) {
  return {
    occurrenceId: turn.id as string,
    threadId: turn.threadId as string,
    turnId: turn.id as string,
    ...(turn.executionId ? { executionId: turn.executionId as string } : {}),
  };
}

function ended(
  turn: Turn,
  end: Extract<FailureRecord, { phase: "ended" }>["end"],
  byTurnId: string | undefined,
  errorCode?: string,
): FailureRecord {
  return {
    ...base(turn),
    phase: "ended",
    failure: { ...failureOfTurn(turn, errorCode), actionable: false },
    end,
    ...(byTurnId ? { byTurnId } : {}),
  };
}

/** A turn settles as failed; if a closing row already follows it, no later walk reaches it, so it ends now. */
async function recordSettled(
  deps: Detector,
  threadId: ThreadId,
  event: Extract<OrchestratorEvent, { type: "turn.error" }>,
): Promise<void> {
  const { turn } = event;
  const code = event.error.code;
  deps.eventWriter.recordFailure?.({
    ...base(turn),
    phase: "recorded",
    failure: failureOfTurn(turn, code),
  });
  const thread = await deps.repos.threads.findById(threadId);
  const { latest, walkedOver } = await latestRowAt(
    deps.repos.turns,
    thread?.activeLeafTurnId ?? null,
  );
  const followed =
    latest !== null && latest.id !== turn.id && !walkedOver.some((walked) => walked.id === turn.id);
  if (followed) deps.eventWriter.recordFailure?.(ended(turn, "moved_on", latest.id, code));
}

/**
 * Records that each failed turn in `turnIds` ended; ids of turns that did not fail (a forgotten message)
 * are skipped, and so is anything `already` says ended another way.
 */
export async function recordEnded(
  deps: Detector,
  turnIds: readonly string[],
  end: Extract<FailureRecord, { phase: "ended" }>["end"],
  byTurnId: string | undefined,
  already?: (turn: Turn) => Promise<boolean>,
): Promise<void> {
  if (!deps.eventWriter.recordFailure) return;
  const graph = turnGraph(deps.repos.turns);
  for (const id of turnIds) {
    const turn = await graph.findById(id as never);
    if (turn?.status !== "error" || (await already?.(turn))) continue;
    deps.eventWriter.recordFailure(ended(turn, end, byTurnId));
  }
}

function isHandoffSeed(turn: Turn): boolean {
  const metadata = turn.metadata;
  return (
    !!metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.kind === "derivation_seed" &&
    metadata.derivation === "handoff"
  );
}

/** Turns a closing row passes with their content kept end as moved on. */
export async function recordPassed(
  deps: Detector,
  threadId: ThreadId,
  passedIds: readonly string[],
  byTurnId: string | undefined,
): Promise<void> {
  if (passedIds.length === 0 || !deps.eventWriter.recordFailure) return;
  // A failed seed that a later seed retried ended as `retried` when the Retry began.
  const latestSeed = await deps.repos.turns.findLatestHandoffSeed(threadId);
  await recordEnded(
    deps,
    passedIds,
    "moved_on",
    byTurnId,
    async (turn) => isHandoffSeed(turn) && latestSeed !== null && latestSeed.id !== turn.id,
  );
}

/** The detection for one durable event, run inside the transaction that projected it. */
export async function detectFailures(
  deps: Detector,
  threadId: ThreadId,
  event: OrchestratorEvent,
): Promise<void> {
  if (!deps.eventWriter.recordFailure) return;
  if (event.type === "turn.error") await recordSettled(deps, threadId, event);
  else if (event.type === "turns.forgotten")
    await recordEnded(deps, event.turnIds, event.reason, event.byTurnId);
}
