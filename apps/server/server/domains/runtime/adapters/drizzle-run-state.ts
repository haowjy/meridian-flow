import { usageFailure } from "@meridian/contracts/failures";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { RunState } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { cursorSeqForJournalHead, eventSeqForJournalEvent } from "../../threads/index.js";
import type { EventJournalWriter, FailureRecorder } from "../../threads/ports/event-journal.js";
import { projectRunState, type RunStateBody } from "../loop/run-state.js";
import { toInboxMessage } from "./drizzle-inbox.js";

export type RunStatePublisher = {
  db: DrizzleDatabase;
  events: Pick<EventJournalWriter, "appendEvent"> & FailureRecorder;
};

type PublicationState = {
  locked: Set<ThreadId>;
  changed: Set<ThreadId>;
  flushed: boolean;
  publisher: RunStatePublisher | null;
};

function participant(
  publisher: RunStatePublisher | null,
): DrizzleTransactionParticipant<PublicationState> {
  return {
    key: PUBLICATION_KEY,
    create: () => ({ locked: new Set(), changed: new Set(), flushed: false, publisher }),
    fork: (parent) => ({
      locked: new Set(parent.locked),
      changed: new Set(parent.changed),
      flushed: parent.flushed,
      publisher: parent.publisher,
    }),
    merge: (_parent, child) => child,
    async beforeCommit(state) {
      for (const threadId of [...state.changed]) {
        await append(requirePublisher(state), threadId);
        state.changed.delete(threadId);
      }
      state.flushed = true;
    },
  };
}
const PUBLICATION_KEY = {};

const stateFor = (publisher: RunStatePublisher | null) =>
  enlistDrizzleTransactionParticipant(participant(publisher));

function requirePublisher(state: PublicationState): RunStatePublisher {
  if (!state.publisher) throw new Error("Run-state publication has no event writer");
  return state.publisher;
}

export function noteThreadLocked(threadId: ThreadId, publisher: RunStatePublisher | null) {
  const state = stateFor(publisher);
  state.locked.add(threadId);
  state.publisher ??= publisher;
}

export function markRunStateChanged(threadId: ThreadId) {
  const state = stateFor(null);
  if (!state.locked.has(threadId))
    throw new Error(`Run-state input written without the thread lock: ${threadId}`);
  if (state.flushed)
    throw new Error(`Run-state input written after its record was published: ${threadId}`);
  state.changed.add(threadId);
}

export async function readRunState(db: DrizzleDatabase, threadId: ThreadId): Promise<RunStateBody> {
  const conn = currentDrizzleDb(db);
  const [messages, [lease], [sent], [thread]] = await Promise.all([
    conn
      .select()
      .from(schema.threadInboxMessages)
      .where(
        and(
          eq(schema.threadInboxMessages.threadId, threadId),
          isNull(schema.threadInboxMessages.deliveredAt),
        ),
      )
      .orderBy(asc(schema.threadInboxMessages.seq)),
    conn
      .select({
        executionId: schema.threadRunLeases.executionId,
        turnId: schema.threadRunLeases.turnId,
        adoptedMessageIds: schema.threadRunLeases.adoptedMessageIds,
      })
      .from(schema.threadRunLeases)
      .where(eq(schema.threadRunLeases.threadId, threadId))
      .limit(1),
    conn
      .select({ seq: sql<number | null>`max(${schema.threadInboxMessages.seq})` })
      .from(schema.threadInboxMessages)
      .where(
        and(
          eq(schema.threadInboxMessages.threadId, threadId),
          eq(schema.threadInboxMessages.intent, "message"),
          sql`${schema.threadInboxMessages.provenance}->>'kind' = 'writer'`,
        ),
      ),
    conn
      .select({
        mode: schema.threads.aiWriteMode,
        blockedReason: schema.threads.inboxBlockedReason,
      })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1),
  ]);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  const [carrier] = lease
    ? await conn
        .select({ id: schema.turns.id })
        .from(schema.turns)
        .where(
          and(
            eq(schema.turns.threadId, threadId),
            sql`${schema.turns.executionId}::text = ${lease.executionId}`,
          ),
        )
        .limit(1)
    : [];
  return projectRunState({
    messages: messages.map(toInboxMessage),
    lease: lease ?? null,
    executionOpen: carrier !== undefined,
    sentThrough: Number(sent?.seq ?? 0),
    mode: thread.mode,
    blockedReason: thread.blockedReason,
  });
}

async function append(publisher: RunStatePublisher, threadId: ThreadId) {
  const runState = await readRunState(publisher.db, threadId);
  const journalSeq = await publisher.events.appendEvent(threadId, {
    type: "run_state.changed",
    threadId,
    runState,
  });
  return { ...runState, version: eventSeqForJournalEvent(journalSeq, 0).toString() };
}

function lockedState(threadId: ThreadId) {
  const state = stateFor(null);
  if (!state.locked.has(threadId))
    throw new Error(`Run state read without the thread lock: ${threadId}`);
  return state;
}

export async function publishRunState(threadId: ThreadId) {
  const state = lockedState(threadId);
  const record = await append(requirePublisher(state), threadId);
  state.changed.delete(threadId);
  return record;
}

export async function answerRunState(threadId: ThreadId) {
  const state = lockedState(threadId);
  if (state.changed.has(threadId)) return publishRunState(threadId);
  return readRunStateAtHead(requirePublisher(state).db, threadId);
}

export async function readRunStateAtHead(
  db: DrizzleDatabase,
  threadId: ThreadId,
): Promise<RunState> {
  const read = async () => {
    const body = await readRunState(db, threadId);
    const [row] = await currentDrizzleDb(db)
      .select({ nextSeq: schema.threads.nextSeq })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    return { ...body, version: cursorSeqForJournalHead(row?.nextSeq ?? 0n).toString() };
  };
  return isInDrizzleTransaction() ? read() : runInRootDrizzleReadSnapshot(db, read);
}

export async function recordUsageTransition(
  threadId: ThreadId,
  was: "credits_exhausted" | null,
  now: "credits_exhausted" | null,
) {
  const publisher = lockedState(threadId).publisher;
  if (!publisher || (was === null) === (now === null)) return;
  const [row] = await currentDrizzleDb(publisher.db)
    .select({ seq: sql<string | null>`max(${schema.eventJournal.seq})` })
    .from(schema.eventJournal)
    .where(
      and(
        eq(schema.eventJournal.threadId, threadId),
        eq(schema.eventJournal.eventType, "run_state.changed"),
        sql`${schema.eventJournal.payload}->'runState'->>'blocked' IS NULL`,
      ),
    );
  const base = {
    occurrenceId: `usage:${threadId}:${row?.seq ?? "0"}`,
    threadId,
    failure: usageFailure(now ?? was ?? "credits_exhausted"),
  };
  publisher.events.recordFailure(
    now
      ? { ...base, phase: "recorded" }
      : {
          ...base,
          phase: "ended",
          end: "resolved",
          failure: { ...base.failure, actionable: false },
        },
  );
}
