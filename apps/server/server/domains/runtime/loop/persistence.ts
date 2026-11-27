import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isClosingRow, type OrchestratorEvent, type Turn } from "@meridian/contracts/threads";
import {
  type LiveEventWriter,
  projectReadModelEvent,
  type ThreadRepositories,
} from "../../threads/index.js";
import { detectFailures, recordEnded } from "./failure-detection.js";
import {
  appendedTurns,
  decideForgetting,
  type ForgettingDecision,
  loadForgettingFacts,
} from "./forget-failed-attempt.js";

export type PersistenceDeps = {
  repos: Pick<
    ThreadRepositories,
    | "blocks"
    | "mediaInclusions"
    | "modelResponses"
    | "runTurnStartTransition"
    | "threads"
    | "transaction"
    | "turns"
  >;
  eventWriter: LiveEventWriter;
  savepoint?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export async function persistAndAppendEvents<T>(
  deps: PersistenceDeps,
  threadId: ThreadId,
  operation: () => Promise<{ result: T; events: OrchestratorEvent[] }>,
  options?: { afterEvents?: (result: T) => Promise<void> },
): Promise<{ result: T; events: OrchestratorEvent[]; createdTurns: Turn[] }> {
  return deps.repos.transaction(() => projectAndAppendEvents(deps, threadId, operation, options));
}

export async function persistAndAppendTurnStartEvents<T>(
  deps: PersistenceDeps,
  threadId: ThreadId,
  expectedActiveLeafTurnId: TurnId | null,
  operation: () => Promise<{ result: T; events: OrchestratorEvent[] }>,
  options?: { afterEvents?: (result: T) => Promise<void>; expectedForgetting?: ForgettingDecision },
): Promise<{ result: T; events: OrchestratorEvent[]; createdTurns: Turn[] }> {
  const forgetting = async () => {
    const persisted = await operation();
    const created = persisted.events.flatMap((event) =>
      event.type === "turn.created" ? [event.turn] : [],
    );
    const appended = appendedTurns(created);
    if (!appended.closes) {
      if (options?.expectedForgetting && options.expectedForgetting.forget.length > 0)
        throw new ForgettingMismatchError(threadId);
      return persisted;
    }
    const decision = decideForgetting(
      await loadForgettingFacts(deps.repos, threadId, expectedActiveLeafTurnId),
      appended,
    );
    if (options?.expectedForgetting && !sameForgotten(options.expectedForgetting, decision))
      throw new ForgettingMismatchError(threadId);
    const first = persisted.events.findIndex(
      (event) => event.type === "turn.created" && isClosingRow(event.turn),
    );
    const closing = persisted.events[first];
    if (closing?.type === "turn.created")
      for (const { turnId, end } of decision.ends)
        await recordEnded(deps, [turnId], end, closing.turn.id);
    if (decision.forget.length === 0 || decision.reason === null) return persisted;
    if (closing?.type !== "turn.created") return persisted;
    const events = [...persisted.events];
    events.splice(first + 1, 0, {
      type: "turns.forgotten",
      turnIds: [...decision.forget],
      byTurnId: closing.turn.id,
      reason: decision.reason,
    });
    return { ...persisted, events };
  };
  return deps.repos.runTurnStartTransition(threadId, expectedActiveLeafTurnId, () =>
    projectAndAppendEvents(deps, threadId, forgetting, options),
  );
}

export class ForgettingMismatchError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`The forgetting decided at run start differs from the commit's: ${threadId}`);
    this.name = "ForgettingMismatchError";
  }
}

function sameForgotten(left: ForgettingDecision, right: ForgettingDecision): boolean {
  const a = [...left.forget].sort();
  const b = [...right.forget].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

async function projectAndAppendEvents<T>(
  deps: PersistenceDeps,
  threadId: ThreadId,
  operation: () => Promise<{ result: T; events: OrchestratorEvent[] }>,
  options?: { afterEvents?: (result: T) => Promise<void> },
): Promise<{ result: T; events: OrchestratorEvent[]; createdTurns: Turn[] }> {
  const persisted = await operation();
  const createdTurns: Turn[] = [];
  for (const event of persisted.events) {
    const created = await projectReadModelEvent(deps.repos, event);
    if (event.type === "turn.created" && created) {
      event.turn.position = created.position;
      createdTurns.push(created);
    }
    await deps.eventWriter.appendEvents(threadId, [event]);
    await detectFailures(deps, threadId, event);
  }
  await options?.afterEvents?.(persisted.result);
  return { ...persisted, createdTurns };
}
