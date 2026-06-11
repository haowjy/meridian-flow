import type { ThreadId } from "@meridian/contracts/runtime";
import type { JsonValue, OrchestratorEvent } from "@meridian/contracts/threads";
import {
  createDrizzleEventJournal,
  type Database,
  type EventJournalRecord,
} from "@meridian/database";
import { createThreadEventHub, type ThreadEventHub } from "./event-hub.js";
import { createThreadRuntimeService, type ThreadRuntimeService } from "./runtime-service.js";

export type JournalEventEnvelope = OrchestratorEvent;

export interface EventJournalReader {
  readAfter(threadId: ThreadId, afterSeq: string, limit?: number): Promise<EventJournalRecord[]>;
  headSeq(threadId: ThreadId): Promise<string>;
}

export interface EventJournalWriter {
  appendEvent(threadId: ThreadId, event: JournalEventEnvelope): Promise<bigint>;
}

export type ThreadRepositories = {
  readonly phase: "phase3";
};

export function createInMemoryRepositories(): ThreadRepositories {
  return { phase: "phase3" };
}

export function createDrizzleEventJournalReader(db: Database): EventJournalReader {
  const journal = createDrizzleEventJournal(db);
  return {
    async readAfter(threadId, afterSeq, limit) {
      return journal.readAfter(threadId, afterSeq, limit);
    },
    headSeq: journal.headSeq,
  };
}

export function createDrizzleEventJournalWriter(db: Database): EventJournalWriter {
  const journal = createDrizzleEventJournal(db);
  return {
    async appendEvent(threadId, event) {
      const seq = await journal.append({
        threadId,
        turnId: "turn" in event ? event.turn.id : "turnId" in event ? event.turnId : null,
        eventType: event.type,
        payload: event as JsonValue,
      });
      return BigInt(seq);
    },
  };
}

export function createDrizzleRepositories(_db: Database): ThreadRepositories {
  return createInMemoryRepositories();
}

export type { SequencedEventInternal } from "./event-hub.js";
export type { ThreadEventHub, ThreadRuntimeService };
export { createThreadEventHub, createThreadRuntimeService };
