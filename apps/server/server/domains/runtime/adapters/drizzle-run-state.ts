/**
 * The run-state record on Postgres: the reader (`readRunState`, rows to record), the transaction
 * participant that publishes it before commit, and `answerRunState` for command answers.
 *
 * Every write to an input of the record (inbox rows, the lease row, the chat's write mode and usage
 * block) happens under the chat's thread lock and calls `markRunStateChanged`. The participant appends
 * one `run_state.changed` row for each marked chat before the transaction commits, so a chat's last
 * record in a transaction follows its last input write. A mark on a chat whose lock the transaction
 * does not hold throws, so a missing lock fails tests instead of shipping a stale record.
 */
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
import type { EventJournalWriter } from "../../threads/ports/event-journal.js";
import { projectRunState, type RunStateBody } from "../loop/run-state.js";
import { toInboxMessage } from "./drizzle-inbox.js";

/** Where a chat's record goes: the connection it is read on and the writer that appends it. */
export type RunStatePublisher = {
  db: DrizzleDatabase;
  events: Pick<EventJournalWriter, "appendEvent">;
};

type PublicationState = {
  /** Chats whose thread lock this transaction (or an ancestor savepoint) holds. */
  locked: Set<ThreadId>;
  /** Chats with an input write the journal does not yet follow with a record. */
  changed: Set<ThreadId>;
  /** Set by the before-commit flush; a later mark fails instead of committing unpublished. */
  flushed: boolean;
  publisher: RunStatePublisher | null;
};

/**
 * Participant state forks into a savepoint and merges back on release, so a lock taken or a change
 * made inside a rolled-back savepoint disappears with it, as the lock and journal row do in Postgres.
 */
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

/** Called by the thread lock once it holds a chat's lock. */
export function noteThreadLocked(threadId: ThreadId, publisher: RunStatePublisher | null) {
  const state = stateFor(publisher);
  state.locked.add(threadId);
  state.publisher ??= publisher;
}

/** Called by an adapter method that changed an input row of the record, under the chat's lock. */
export function markRunStateChanged(threadId: ThreadId) {
  const state = stateFor(null);
  if (!state.locked.has(threadId))
    throw new Error(`Run-state input written without the thread lock: ${threadId}`);
  if (state.flushed)
    throw new Error(`Run-state input written after its record was published: ${threadId}`);
  state.changed.add(threadId);
}

/** The record's rows on the ambient connection, projected without a version. */
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
  // The predicate of `readOpenExecutionId`: some turn carries the execution, expiry ignored.
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

/** Appends the chat's current record to the journal and returns it at its own stream version. */
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

/**
 * Appends the chat's record now, under its lock, and returns it at its stream version. Later writes in
 * the same transaction mark the chat again, and the commit appends a newer record.
 */
export async function publishRunState(threadId: ThreadId) {
  const state = lockedState(threadId);
  const record = await append(requirePublisher(state), threadId);
  state.changed.delete(threadId);
  return record;
}

/**
 * The record a command answers with, under the chat's lock. If this transaction has changed the chat
 * and not yet published, it publishes now and answers with that record at its stream version.
 * Otherwise nothing is pending, no input can change and no append can move the head, so the record is
 * read at the head, read last.
 */
export async function answerRunState(threadId: ThreadId) {
  const state = lockedState(threadId);
  if (state.changed.has(threadId)) return publishRunState(threadId);
  return readRunStateAtHead(requirePublisher(state).db, threadId);
}

/**
 * The record at the journal head, head read last. A repeatable-read transaction makes the two reads
 * coherent for a snapshot; outside any transaction this opens one. Under the chat's thread lock
 * (`answerRunState`) the head can't move between them.
 */
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
