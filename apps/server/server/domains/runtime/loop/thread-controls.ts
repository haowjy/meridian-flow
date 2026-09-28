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
  findMessage(id: string): Promise<InboxMessage | null>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  findTurn(id: TurnId): Promise<Turn | null>;
  findControlTurn(threadId: ThreadId, controlId: string): Promise<Turn | null>;
  findLatestHandoffSeed(threadId: ThreadId): Promise<Turn | null>;
  pending(threadId: ThreadId): Promise<ThreadPendingInbox>;
  lockReceipt(
    threadId: ThreadId,
    liveOnly: boolean,
  ): Promise<{ ids: string[]; turnId: TurnId | null } | null>;
  cancel(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  acknowledge(threadId: ThreadId, id: string): Promise<void>;
  wake(threadId: ThreadId): void;
  findThread(id: ThreadId): Promise<import("@meridian/contracts/threads").Thread | null>;
  pendingRows(id: ThreadId): Promise<InboxMessage[]>;
  cancelSeed(threadId: ThreadId, turnId: TurnId): Promise<void>;
}): ThreadControls {
  async function cancelUnboundSeed(threadId: ThreadId, row: InboxMessage) {
    if (row.body.kind !== "handoff_brief" || !row.body.seedTurnId) return;
    const seed = await deps.findTurn(row.body.seedTurnId);
    if (seed?.status === "pending") await deps.cancelSeed(threadId, seed.id);
  }
  return {
    cancelPendingSeed: (threadId, turnId) =>
      deps.withThreadLock(threadId, async () => {
        const receipt = await deps.lockReceipt(threadId, true);
        const row = (await deps.pendingRows(threadId)).find(
          (row) =>
            row.intent === "control" &&
            row.body.kind === "handoff_brief" &&
            row.body.seedTurnId === turnId,
        );
        if (!row || receipt?.ids.includes(row.id)) return false;
        await cancelUnboundSeed(threadId, row);
        await deps.acknowledge(threadId, row.id);
        deps.wake(threadId);
        return true;
      }),
    enqueueControl: (input) =>
      deps.withThreadLock(input.threadId, async () => {
        if (input.control.kind === "handoff_brief") {
          const thread = await deps.findThread(input.threadId);
          if (thread?.originType !== "handoff" || input.control.seedTurnId)
            throw new ThreadControlError(409, "not_a_handoff_retry");
        }
        const existing = await deps.findMessage(input.id);
        if (
          existing &&
          (existing.threadId !== input.threadId ||
            existing.intent !== "control" ||
            existing.body.kind !== input.control.kind)
        )
          throw new ThreadControlError(409, "control_id_conflict");
        if (!existing && input.control.kind === "handoff_brief") {
          const latest = await deps.findLatestHandoffSeed(input.threadId);
          const pending = await deps.pendingRows(input.threadId);
          if (
            !latest ||
            (latest.status !== "error" && latest.status !== "cancelled") ||
            pending.some((row) => row.body.kind === "handoff_brief")
          )
            throw new ThreadControlError(409, "handoff_retry_unavailable");
        }
        if (!existing && input.control.kind === "compaction_undo") {
          const target = await deps.findTurn(input.control.compactionTurnId);
          if (!target || target.threadId !== input.threadId || target.role !== "compaction")
            throw new ThreadControlError(404, "compaction_not_found");
        }
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
        if (row.deliveredAt) return { outcome: "already_finished" };
        const receipt = await deps.lockReceipt(
          threadId,
          row.body.kind === "handoff_brief" && !!row.body.seedTurnId,
        );
        if (receipt?.ids.includes(controlId) && receipt.turnId) {
          const turn = await deps.findTurn(receipt.turnId);
          if ((turn?.metadata as JsonObject | null)?.satisfiesControlId === controlId)
            return { outcome: "already_finished" };
          if (await deps.cancel(threadId, receipt.turnId)) {
            // A cancelled owner can die before cleanup; withdrawal must never replay the control.
            await deps.acknowledge(threadId, controlId);
            deps.wake(threadId);
            return { outcome: "stopping" };
          }
        }
        await cancelUnboundSeed(threadId, row);
        await deps.acknowledge(threadId, controlId);
        deps.wake(threadId);
        return { outcome: "withdrawn" };
      }),
  };
}
