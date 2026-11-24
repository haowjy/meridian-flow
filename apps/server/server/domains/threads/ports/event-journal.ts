import type { FailureRecord } from "@meridian/contracts/failures";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";

export type JournalEventEnvelope = OrchestratorEvent;

export const JOURNAL_ONLY_EVENT_TYPES = [
  "stream.delta",
  "tool.executing",
  "tool.output_delta",
  "tool.connection_call",
] as const;

export const REPLY_FINISHED_EVENT_TYPES = [
  "turn.completed",
  "turn.cancelled",
  "turn.error",
] as const;

export interface EventJournalWriter {
  appendEvents(threadId: ThreadId, events: readonly JournalEventEnvelope[]): Promise<bigint>;
  appendEvent(threadId: ThreadId, event: JournalEventEnvelope): Promise<bigint>;
}

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

export interface EventJournalReader {
  readAfter(threadId: ThreadId, afterSeq: bigint, limit?: number): Promise<JournalEntry[]>;
  lastSeqBefore(
    threadId: ThreadId,
    beforeSeq: bigint,
    eventTypes: readonly JournalEventEnvelope["type"][],
  ): Promise<bigint>;
  headSeq(threadId: ThreadId): Promise<bigint>;
  readModelProjectionWatermark(threadId: ThreadId): Promise<bigint>;
}

export type LiveEventWriter = EventJournalWriter & FailureRecorder;
