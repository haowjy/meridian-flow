/**
 * Persists a writer send's user turn at enqueue, atomically with the admission
 * settlement, document attachment, and inbox append. The producer mints the turn
 * id and reuses it as the inbox message id, so the drain recognizes the message
 * as already-persisted (`knownTurnIds`) and chains its assistant container from
 * this turn instead of appending a second one.
 *
 * `settle` and `enqueue` run inside the turn-start transaction. `enqueue` goes
 * through `ThreadedInbox`, whose per-thread lock reuses the ambient transaction,
 * so the durable message joins the same commit and its post-commit wake is
 * scheduled by the outer transaction.
 */
import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { WorkContextDelivery } from "../../projects/index.js";
import { TurnStartConflictError } from "../../threads/index.js";
import { planMessageTurns } from "./inbox-context.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { Inbox, MessageDraft } from "./ports.js";
import type { ThreadedInbox } from "./threaded-inbox.js";
import { writerUserTurnBlocks } from "./user-turn-blocks.js";

export interface WriterEnqueueSettlement {
  userTurnId: TurnId;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
}

/**
 * Signals that `settle` chose a winner other than this attempt while the
 * writer turn and inbox message were already staged. Throwing rolls the
 * turn-start transaction back; the carried projection is returned instead of
 * committing a rejected or losing submission.
 */
export class WriterEnqueueRollback<T> extends Error {
  constructor(readonly result: T) {
    super("writer enqueue aborted by an admission winner");
    this.name = "WriterEnqueueRollback";
  }
}

export async function persistWriterEnqueue<T>(input: {
  persistence: PersistenceDeps;
  hub: { headSeq(threadId: ThreadId): Promise<bigint> };
  workContextDelivery: Pick<WorkContextDelivery, "beforeTurn">;
  threadId: ThreadId;
  userTurnId: TurnId;
  userBlocks: readonly UserMessageBlock[];
  userTurnMetadata?: JsonValue | null;
  threadedInbox: ThreadedInbox;
  inbox: Pick<Inbox, "listPending">;
  draft: MessageDraft;
  /** Settles admission plus attachments; runs in the turn-start transaction. */
  settle: (settlement: WriterEnqueueSettlement) => Promise<T>;
}): Promise<T> {
  const resumeAfterSeq = (await input.hub.headSeq(input.threadId)).toString();
  // Preserve the writer-run order: any pending Work-context update persists
  // before the writer's turn.
  await input.workContextDelivery.beforeTurn(input.threadId);

  for (let attempt = 0; ; attempt += 1) {
    const thread = await input.persistence.repos.threads.findById(input.threadId);
    if (!thread) throw new Error(`Thread not found: ${input.threadId}`);
    try {
      return await input.threadedInbox.withThreadLock(input.threadId, async (producer) => {
        let settled: T | undefined;
        const persistAttempt = () =>
          persistAndAppendTurnStartEvents(
            input.persistence,
            input.threadId,
            thread.activeLeafTurnId,
            async () => {
              // A queued child/agent message may predate this durable writer turn.
              // Materialize that prefix now rather than later reparenting history.
              const batch = await input.inbox.listPending(input.threadId);
              const known = new Set(
                (await input.persistence.repos.turns.listByThread(input.threadId)).map(
                  (turn) => turn.id,
                ),
              );
              const prefix = planMessageTurns({
                batch,
                prevTurnId: thread.activeLeafTurnId ?? null,
                knownTurnIds: known,
              });
              const userTurn = createLocalTurn({
                id: input.userTurnId,
                threadId: input.threadId,
                prevTurnId: prefix.leafTurnId,
                role: "user",
                status: "complete",
                metadata: input.userTurnMetadata ?? null,
              });
              const blocks = writerUserTurnBlocks(userTurn.id, input.userBlocks);
              return {
                result: { userTurn },
                events: [
                  ...prefix.events,
                  { type: "turn.created" as const, turn: userTurn },
                  ...blocks.map((block) => ({ type: "block.upserted" as const, block })),
                ],
              };
            },
            {
              afterEvents: async ({ userTurn }) => {
                await producer.enqueue(input.draft);
                settled = await input.settle({
                  userTurnId: userTurn.id,
                  resumeAfterSeq,
                  snapshotFloorNextSeq: ((await input.hub.headSeq(input.threadId)) + 1n).toString(),
                });
              },
            },
          );
        await (input.persistence.savepoint
          ? input.persistence.savepoint(persistAttempt)
          : persistAttempt());
        if (settled === undefined) throw new Error("Writer enqueue did not settle");
        return settled;
      });
    } catch (error) {
      if (error instanceof WriterEnqueueRollback) return error.result as T;
      if (!(error instanceof TurnStartConflictError) || attempt >= 2) throw error;
    }
  }
}
