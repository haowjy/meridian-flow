/**
 * Writer control commands serialize idempotency, cancel-out and withdrawal
 * with boundary reservation. Every request writes its own row, so a replay
 * always finds it and answers that row's state.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ControlBody, ThreadPendingInbox, Turn } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { queuedWriteModeSwitch } from "./next-inbox-work.js";
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
  /** Enqueue and wake the thread. */
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  enqueueWithoutWake(draft: MessageDraft): Promise<InboxMessage>;
  selectPending(threadId: ThreadId): Promise<InboxMessage[]>;
  threadWriteMode(threadId: ThreadId): Promise<AiWriteMode>;
  applyDueSwitches(threadId: ThreadId): Promise<void>;
  findControlTurn(threadId: ThreadId, controlId: string): Promise<Turn | null>;
  pending(threadId: ThreadId): Promise<ThreadPendingInbox>;
  acknowledge(threadId: ThreadId, ids: readonly string[]): Promise<void>;
  hasCompletedReply(threadId: ThreadId): Promise<boolean>;
}): ThreadControls {
  return {
    async enqueueControl(input) {
      const draft: MessageDraft = {
        id: input.id,
        threadId: input.threadId,
        intent: "control",
        body: input.control,
        provenance: { kind: "writer", actorId: input.actorId },
        idempotencyKey: input.id,
      };
      const outcome = await deps.withThreadLock(input.threadId, async () => {
        const existing = await deps.findMessage(input.id);
        if (existing) {
          if (
            existing.threadId !== input.threadId ||
            existing.intent !== "control" ||
            !sameControl(existing.body as ControlBody, input.control)
          )
            throw new ThreadControlError(409, "control_id_conflict");
          return { created: false, apply: false };
        }
        if (input.control.kind === "compact") {
          if (!(await deps.hasCompletedReply(input.threadId)))
            throw new ThreadControlError(409, "compact_requires_completed_reply");
          await deps.enqueue(draft);
          return { created: true, apply: false };
        }
        const queued = queuedWriteModeSwitch(await deps.selectPending(input.threadId));
        const unchanged = queued
          ? queued.body.mode === input.control.mode
          : (await deps.threadWriteMode(input.threadId)) === input.control.mode;
        if (queued || unchanged) {
          // A switch back cancels the queued switch; a same-mode request leaves
          // things alone. Either way the row is written already acknowledged,
          // so nothing shows in the chat and a replay finds it settled.
          await deps.enqueueWithoutWake(draft);
          await deps.acknowledge(input.threadId, [
            ...(queued && !unchanged ? [queued.id] : []),
            input.id,
          ]);
          return { created: true, apply: false };
        }
        await deps.enqueueWithoutWake(draft);
        return { created: true, apply: true };
      });
      if (outcome.apply) await deps.applyDueSwitches(input.threadId);
      const turn = await deps.findControlTurn(input.threadId, input.id);
      const pending =
        (await deps.pending(input.threadId)).items.find((item) => item.id === input.id) ?? null;
      return {
        created: outcome.created,
        response: { id: input.id, pending, turnId: turn?.id ?? null },
      };
    },
    withdrawControl: (threadId, controlId) =>
      deps.withThreadLock(threadId, async () => {
        const row = await deps.findMessage(controlId);
        if (row?.threadId !== threadId || row.intent !== "control")
          throw new ThreadControlError(404, "control_not_found");
        if (await deps.findControlTurn(threadId, controlId)) return { outcome: "already_started" };
        if (row.deliveredAt) return { outcome: "withdrawn" };
        await deps.acknowledge(threadId, [controlId]);
        return { outcome: "withdrawn" };
      }),
  };
}

function sameControl(left: ControlBody, right: ControlBody): boolean {
  if (left.kind === "compact")
    return right.kind === "compact" && left.instructions === right.instructions;
  return right.kind === "write_mode" && left.mode === right.mode;
}
