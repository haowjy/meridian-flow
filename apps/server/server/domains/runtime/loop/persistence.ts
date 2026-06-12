// @ts-nocheck
/**
 * Persistence helper: runs a unit of work in a thread-repository transaction,
 * appends the resulting orchestrator events to the journal, and projects
 * durable read-model events atomically. Owns the loop's single mutation +
 * journal + projection seam.
 *
 * Two write paths:
 *
 * 1. **persistAndAppendEvents** — the transactional path used for events
 *    that carry durable authority (turn.created, model.response_received,
 *    block.upserted, turn.completed/cancelled/error).  Within a single repo
 *    transaction:
 *    a) The operation callback produces `{ result, events }`.
 *    b) Each event is appended to the event journal (durable log).
 *    c) Each event is passed to `projectReadModelEvent`, which writes the
 *       corresponding read-model rows (turns, model_responses, turn_blocks)
 *       and recomputes rollups.
 *    This guarantees journal + read-model stay consistent — either both
 *    are committed or neither is.
 *
 * 2. **appendEvent** — the non-transactional path used for ephemeral
 *    transport events (stream.delta, tool.executing, tool.output_delta).
 *    These are appended to the journal for live fan-out/catch-up but do NOT
 *    trigger read-model projection (the read-model projector ignores them).
 *
 * Boundary: the read-model projector (`projectReadModelEvent`) is the
 * in-transaction transform from durable events to repository rows. It lives
 * in the threads domain because it must know about all repository types.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import {
  type EventJournalWriter,
  projectReadModelEvent,
  type ThreadRepositories,
} from "../../threads/index.js";

export type PersistenceDeps = {
  repos: Pick<
    ThreadRepositories,
    "blocks" | "modelResponses" | "threads" | "transaction" | "turns"
  >;
  eventWriter: EventJournalWriter;
};

// The transactional path: journal append + read-model projection in a
// single repo transaction.  The operation callback produces events; each
// event is appended to the journal then passed to the read-model projector
// which writes repository rows.
export async function persistAndAppendEvents<T>(
  deps: PersistenceDeps,
  threadId: ThreadId,
  operation: () => Promise<{ result: T; events: OrchestratorEvent[] }>,
): Promise<{ result: T; events: OrchestratorEvent[] }> {
  return deps.repos.transaction(async () => {
    const persisted = await operation();
    for (const event of persisted.events) {
      await deps.eventWriter.appendEvent(threadId, event);
      await projectReadModelEvent(deps.repos, event);
    }
    return persisted;
  });
}

// Non-transactional path: journal-only append for ephemeral transport
// events that don't need read-model projection.
export async function appendEvent(
  writer: EventJournalWriter,
  threadId: ThreadId,
  event: OrchestratorEvent,
): Promise<OrchestratorEvent> {
  await writer.appendEvent(threadId, event);
  return event;
}
