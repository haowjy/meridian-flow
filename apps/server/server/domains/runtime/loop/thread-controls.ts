/** Writer control commands serialize idempotency and withdrawal with boundary reservation. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadPendingInbox, Turn } from "@meridian/contracts/threads";
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
  findMessage(id: string): Promise<InboxMessage | null>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  findControlTurn(threadId: ThreadId, controlId: string): Promise<Turn | null>;
  pending(threadId: ThreadId): Promise<ThreadPendingInbox>;
  acknowledge(threadId: ThreadId, id: string): Promise<void>;
}): ThreadControls {
  return {
    enqueueControl: (input) =>
      deps.withThreadLock(input.threadId, async () => {
        const existing = await deps.findMessage(input.id);
        if (
          existing &&
          (existing.threadId !== input.threadId ||
            existing.intent !== "control" ||
            existing.body.kind !== input.control.kind)
        )
          throw new ThreadControlError(409, "control_id_conflict");
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
        const turn = await deps.findControlTurn(input.threadId, row.id);
        const pending =
          (await deps.pending(input.threadId)).items.find((item) => item.id === row.id) ?? null;
        return { created: !existing, response: { id: row.id, pending, turnId: turn?.id ?? null } };
      }),
    withdrawControl: (threadId, controlId) =>
      deps.withThreadLock(threadId, async () => {
        const row = await deps.findMessage(controlId);
        if (row?.threadId !== threadId || row.intent !== "control")
          throw new ThreadControlError(404, "control_not_found");
        if (await deps.findControlTurn(threadId, controlId)) return { outcome: "already_started" };
        if (row.deliveredAt) return { outcome: "withdrawn" };
        await deps.acknowledge(threadId, controlId);
        return { outcome: "withdrawn" };
      }),
  };
}
