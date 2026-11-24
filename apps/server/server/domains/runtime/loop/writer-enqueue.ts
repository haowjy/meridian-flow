import type { AdmittedMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { BlockUpsertedRow, JsonValue } from "@meridian/contracts/threads";
import { TurnStartConflictError } from "../../threads/index.js";
import { createLocalTurn } from "./local-turn.js";
import { type PersistenceDeps, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { MessageDraft } from "./ports.js";
import type { DeliveryProducer, DeliveryTransaction } from "./runtime-delivery.js";
import { writerUserTurnBlocks } from "./user-turn-blocks.js";

export interface WriterEnqueueSettlement {
  userTurnId: TurnId;
  runStateVersion: string | null;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
}

export class WriterEnqueueRollback<T> extends Error {
  constructor(readonly result: T) {
    super("writer enqueue aborted by an admission winner");
    this.name = "WriterEnqueueRollback";
  }
}

export async function persistWriterTurn(input: {
  persistence: PersistenceDeps;
  threadId: ThreadId;
  userTurnId: TurnId;
  userBlocks: readonly AdmittedMessageBlock[];
  userTurnMetadata?: JsonValue | null;
  seedBlocks?: BlockUpsertedRow[];
  origin: "system" | "writer";
  producer: DeliveryTransaction;
  draft: MessageDraft;
  beforePersist?: () => Promise<void>;
  afterEnqueue?: (userTurnId: TurnId) => Promise<void>;
  afterTurnCreated?: (userTurnId: TurnId) => void;
}): Promise<ReturnType<typeof createLocalTurn>> {
  await input.producer.materializePrefix();
  const current = await input.persistence.repos.threads.findById(input.threadId);
  if (!current) throw new Error(`Thread not found: ${input.threadId}`);

  await input.beforePersist?.();
  const persisted = await persistAndAppendTurnStartEvents(
    input.persistence,
    input.threadId,
    current.activeLeafTurnId,
    async () => {
      const userTurn = createLocalTurn({
        id: input.userTurnId,
        threadId: input.threadId,
        position: 1,
        prevTurnId: current.activeLeafTurnId,
        role: "user",
        origin: input.origin,
        status: "complete",
        metadata: input.userTurnMetadata ?? null,
      });
      const blocks = writerUserTurnBlocks(userTurn.id, input.userBlocks);
      const userBlockCount = blocks.length;
      blocks.push(
        ...(input.seedBlocks ?? []).map((block, index) => ({
          ...block,
          turnId: userTurn.id,
          sequence: userBlockCount + index,
        })),
      );
      input.afterTurnCreated?.(userTurn.id);
      return {
        result: { userTurn },
        events: [
          { type: "turn.created" as const, turn: userTurn },
          ...blocks.map((block) => ({ type: "block.upserted" as const, block })),
        ],
      };
    },
    {
      afterEvents: async ({ userTurn }) => {
        await input.producer.enqueue(input.draft);
        await input.afterEnqueue?.(userTurn.id);
      },
    },
  );
  return persisted.result.userTurn;
}

export async function persistWriterEnqueue<T>(input: {
  persistence: PersistenceDeps;
  hub: { headSeq(threadId: ThreadId): Promise<bigint> };
  threadId: ThreadId;
  userTurnId: TurnId;
  userBlocks: readonly AdmittedMessageBlock[];
  joinedReply?: () => Promise<TurnId | null>;
  userTurnMetadata?: (joinedReplyId: TurnId | null) => JsonValue | null;
  delivery: DeliveryProducer;
  beforePersist?: () => Promise<void>;
  draft: MessageDraft;
  settle: (settlement: WriterEnqueueSettlement) => Promise<T>;
}): Promise<T> {
  const resumeAfterSeq = (await input.hub.headSeq(input.threadId)).toString();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.delivery.withThreadLock(input.threadId, async (producer) => {
        let settled: T | undefined;
        const persistAttempt = async () => {
          const joinedReplyId = (await input.joinedReply?.()) ?? null;
          await persistWriterTurn({
            persistence: input.persistence,
            threadId: input.threadId,
            userTurnId: input.userTurnId,
            userBlocks: input.userBlocks,
            userTurnMetadata: input.userTurnMetadata?.(joinedReplyId),
            origin: "writer",
            beforePersist: input.beforePersist,
            producer,
            draft: input.draft,
            afterEnqueue: async (userTurnId) => {
              const runStateVersion = await producer.publishRunState();
              settled = await input.settle({
                userTurnId,
                runStateVersion,
                resumeAfterSeq,
                snapshotFloorNextSeq: ((await input.hub.headSeq(input.threadId)) + 1n).toString(),
              });
            },
          });
        };
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
