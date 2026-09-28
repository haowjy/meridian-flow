/** Writer control commands serialize idempotency and withdrawal with boundary reservation. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonObject, ThreadPendingInbox, Turn } from "@meridian/contracts/threads";
import type { InboxMessage, MessageDraft } from "./ports.js";
import type { ThreadControls } from "./runtime-delivery.js";
import type { ThreadLock } from "./thread-lock.js";

export class ThreadControlError extends Error {
  constructor(
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function createThreadControls(deps: {
  withThreadLock: ThreadLock["withThreadLock"];
  findMessage(threadId: ThreadId, id: string): Promise<InboxMessage | null>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  turns(threadId: ThreadId): Promise<Turn[]>;
  pending(threadId: ThreadId): Promise<ThreadPendingInbox>;
  lockReceipt(threadId: ThreadId): Promise<{ ids: string[]; turnId: TurnId | null } | null>;
  cancel(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  acknowledge(threadId: ThreadId, id: string): Promise<void>;
  wake(threadId: ThreadId): void;
}): ThreadControls {
  return {
    enqueueControl: (input) =>
      deps.withThreadLock(input.threadId, async () => {
        const existing = await deps.findMessage(input.threadId, input.id);
        const row =
          existing ??
          (await deps.enqueue({
            id: input.id,
            threadId: input.threadId,
            intent: "control",
            body: input.control,
            provenance: { kind: "writer", actorId: input.actorId },
            idempotencyKey: input.id,
          }));
        if (row.intent !== "control") throw new ThreadControlError(409, "control_id_conflict");
        const turn = (await deps.turns(input.threadId)).reverse().find((turn) => {
          const metadata = turn.metadata as JsonObject | null;
          return metadata?.controlMessageId === row.id || metadata?.satisfiesControlId === row.id;
        });
        const pending =
          (await deps.pending(input.threadId)).items.find((item) => item.id === row.id) ?? null;
        return { created: !existing, response: { id: row.id, pending, turnId: turn?.id ?? null } };
      }),
    withdrawControl: (threadId, controlId) =>
      deps.withThreadLock(threadId, async () => {
        const receipt = await deps.lockReceipt(threadId);
        const row = await deps.findMessage(threadId, controlId);
        if (row?.intent !== "control") throw new ThreadControlError(404, "control_not_found");
        if (row.deliveredAt) return { outcome: "already_finished" };
        if (
          receipt?.ids.includes(controlId) &&
          receipt.turnId &&
          (await deps.cancel(threadId, receipt.turnId))
        )
          return { outcome: "stopping" };
        await deps.acknowledge(threadId, controlId);
        deps.wake(threadId);
        return { outcome: "withdrawn" };
      }),
  };
}
