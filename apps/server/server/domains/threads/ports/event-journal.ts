/**
 * Event-journal ports: the append-only writer and the reader/replay contracts
 * for persisted orchestrator events (plus envelope/entry types). The boundary
 * the drizzle and in-memory journals implement; the event hub depends on these.
 */
import type { FailureRecord } from "@meridian/contracts/failures";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";

/** Persisted orchestrator event payload. */
export type JournalEventEnvelope = OrchestratorEvent;

/**
 * Journal-only transport facts: these are appended through the loop's
 * non-transactional `appendEvent` path, so the HTTP snapshot cannot have
 * reflected them in read-model rows yet. Output deltas are high-volume live
 * transport facts, but they are still journaled here so WS catch-up/replay uses
 * the same cursor model as every other live event. Other produced events are
 * appended through `persistAndAppendEvents`; some are projector no-ops
 * (usage/tool result), but they are still sequenced with the durable projection
 * transaction.
 */
export const JOURNAL_ONLY_EVENT_TYPES = [
  "stream.delta",
  "tool.executing",
  "tool.output_delta",
] as const;

export interface EventJournalWriter {
  appendEvents(threadId: ThreadId, events: readonly JournalEventEnvelope[]): Promise<bigint>;
  appendEvent(threadId: ThreadId, event: JournalEventEnvelope): Promise<bigint>;
}

/**
 * Logs a failure transition the caller detected in its transaction. It emits after the outermost commit,
 * so a rolled-back transition emits nothing. Live persistence requires one (`PersistenceDeps`); wiring
 * `noFailureRecorder` is the explicit choice where nothing logs diagnostics. The raw journal stays append-only.
 */
export interface FailureRecorder {
  recordFailure(record: FailureRecord): void;
}

export const noFailureRecorder: FailureRecorder = { recordFailure() {} };

export interface JournalEntry {
  id: string;
  threadId: string;
  turnId: string | null;
  seq: bigint;
  eventType: string;
  payload: JournalEventEnvelope;
  createdAt: string;
}

export interface ListJournalEventsOptions {
  limit?: number;
}

export interface EventJournalReader {
  readAfter(threadId: ThreadId, afterSeq: bigint, limit?: number): Promise<JournalEntry[]>;
  /** Latest matching row strictly before the journal-row cursor, or zero when none exists. */
  lastSeqBefore(
    threadId: ThreadId,
    beforeSeq: bigint,
    eventTypes: readonly JournalEventEnvelope["type"][],
  ): Promise<bigint>;
  headSeq(threadId: ThreadId): Promise<bigint>;
  /**
   * Highest journal seq whose event passed through the durable/projecting path.
   * The value is a journal-row seq, not a WS event seq; callers that resume
   * AG-UI streams must convert it to the corresponding event cursor.
   */
  readModelProjectionWatermark(threadId: ThreadId): Promise<bigint>;
  listByThread(threadId: ThreadId, opts?: ListJournalEventsOptions): Promise<JournalEntry[]>;
  listByType(threadId: ThreadId, eventType: string): Promise<JournalEntry[]>;
  listSince(threadId: ThreadId, afterId: string): Promise<JournalEntry[]>;
  listByTimeRange(threadId: ThreadId, from: string, to: string): Promise<JournalEntry[]>;
}

/** What live persistence and delivery take: the append-only journal plus the failure recorder. */
export type LiveEventWriter = EventJournalWriter & FailureRecorder;
