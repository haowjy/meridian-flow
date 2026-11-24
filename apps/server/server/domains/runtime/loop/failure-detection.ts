import {
  classifyReplyFailure,
  type Failure,
  type FailureRecord,
} from "@meridian/contracts/failures";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import { firstClosingRowAfter } from "./latest-row.js";
import type { PersistenceDeps } from "./persistence.js";

type Detector = Pick<PersistenceDeps, "repos" | "eventWriter">;

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

async function recordSettled(
  deps: Detector,
  threadId: ThreadId,
  event: Extract<OrchestratorEvent, { type: "turn.error" }>,
): Promise<void> {
  const { turn } = event;
  const code = event.error.code;
  deps.eventWriter.recordFailure({
    ...base(turn),
    phase: "recorded",
    failure: failureOfTurn(turn, code),
  });
  const thread = await deps.repos.threads.findById(threadId);
  const closing = await firstClosingRowAfter(
    deps.repos.turns,
    thread?.activeLeafTurnId ?? null,
    turn.id,
  );
  if (closing) deps.eventWriter.recordFailure(ended(turn, "moved_on", closing.id, code));
}

export async function recordEnded(
  deps: Detector,
  turnIds: readonly string[],
  end: Extract<FailureRecord, { phase: "ended" }>["end"],
  byTurnId: string | undefined,
): Promise<void> {
  const graph = turnGraph(deps.repos.turns);
  for (const id of turnIds) {
    const turn = await graph.findById(id as never);
    if (turn?.status !== "error") continue;
    deps.eventWriter.recordFailure(ended(turn, end, byTurnId));
  }
}

export async function detectFailures(
  deps: Detector,
  threadId: ThreadId,
  event: OrchestratorEvent,
): Promise<void> {
  if (event.type === "turn.error") await recordSettled(deps, threadId, event);
}
