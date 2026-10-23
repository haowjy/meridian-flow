/**
 * Persistence helper: runs a unit of work in a thread-repository transaction,
 * appends the resulting orchestrator events to the journal, and projects
 * durable read-model events atomically. Owns the loop's single mutation +
 * journal + projection seam.
 *
 * Runtime events use two write paths:
 *
 * 1. **persistAndAppendEvents** — the transactional path used for events
 *    that carry durable authority (turn.created, model.response_received,
 *    block.upserted, turn.completed/cancelled/error).  Within a single repo
 *    transaction:
 *    a) The operation callback produces `{ result, events }`.
 *    b) Each event is passed to `projectReadModelEvent`, which writes the
 *       corresponding read-model rows (turns, model_responses, turn_blocks)
 *       and recomputes rollups.
 *    c) Each event is appended to the event journal (durable log).
 *    This guarantees journal + read-model stay consistent — either both
 *    are committed or neither is.
 *
 * 2. Journal-only transport events do not trigger read-model projection.
 *    Runtime delta scopes send stream and tool-output deltas through the batch
 *    writer; tool lifecycle events such as tool.executing append directly.
 *
 * Boundary: the read-model projector (`projectReadModelEvent`) is the
 * in-transaction transform from durable events to repository rows. It lives
 * in the threads domain because it must know about all repository types.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
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
    | "imageInclusions"
    | "modelResponses"
    | "runTurnStartTransition"
    | "threads"
    | "transaction"
    | "turns"
  >;
  eventWriter: LiveEventWriter;
  /** Real nested transaction boundary when caller already owns a transaction. */
  savepoint?: <T>(operation: () => Promise<T>) => Promise<T>;
};

// The transactional path: journal append + read-model projection in a
// single repo transaction.  The operation callback produces events; each
// event is passed to the read-model projector before journal append so
// Meridian's event_journal.turn_id FK can see the referenced turn row.
export async function persistAndAppendEvents<T>(
  deps: PersistenceDeps,
  threadId: ThreadId,
  operation: () => Promise<{ result: T; events: OrchestratorEvent[] }>,
  options?: { afterEvents?: (result: T) => Promise<void> },
): Promise<{ result: T; events: OrchestratorEvent[]; createdTurns: Turn[] }> {
  return deps.repos.transaction(() => projectAndAppendEvents(deps, threadId, operation, options));
}

/**
 * The one append primitive for turns at a boundary. When the appended turns hold a closing row it decides
 * what the boundary forgets (`decideForgetting`, design-fx.md) and records it in the same commit: a
 * `turns.forgotten` event right after the first closing `turn.created`, which the projector stamps.
 * Run start decided first, so its request already left those turns out; `expectedForgetting` is that
 * decision, and the two must agree or the request was built on the wrong history.
 */
export async function persistAndAppendTurnStartEvents<T>(
  deps: PersistenceDeps,
  threadId: ThreadId,
  expectedActiveLeafTurnId: import("@meridian/contracts/runtime").TurnId | null,
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
    // Only the commit's decision records the ends: run start decided the same, and one record each.
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

/** Run start's decision and the commit's differ: the request was built over the wrong history. */
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
