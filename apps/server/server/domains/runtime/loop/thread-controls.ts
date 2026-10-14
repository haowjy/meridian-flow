/**
 * Writer control commands serialize idempotency, cancel-out and withdrawal
 * with boundary reservation. Every request writes its own row, so a replay
 * always finds it and answers that row's state.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  ControlBody,
  PendingInboxItem,
  ThreadPendingInbox,
  Turn,
  WithdrawThreadControlResponse,
} from "@meridian/contracts/threads";
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
  /**
   * Writes the row already acknowledged, with the rows it cancels, then
   * publishes the final queue once: no snapshot ever shows the settled row.
   */
  enqueueSettled(draft: MessageDraft, cancelledIds: readonly string[]): Promise<void>;
  selectPending(threadId: ThreadId): Promise<InboxMessage[]>;
  threadWriteMode(threadId: ThreadId): Promise<AiWriteMode>;
  /** The thread's journal head in the socket's cursor space: the last frame seq it holds. */
  headSeq(threadId: ThreadId): Promise<bigint>;
  /** The Work's default follows the writer's latest choice, applied or not. */
  setWorkDefault(threadId: ThreadId, mode: AiWriteMode): Promise<void>;
  findControlTurn(threadId: ThreadId, controlId: string): Promise<Turn | null>;
  pending(threadId: ThreadId): Promise<ThreadPendingInbox>;
  acknowledge(threadId: ThreadId, ids: readonly string[]): Promise<void>;
  hasCompletedReply(threadId: ThreadId): Promise<boolean>;
}): ThreadControls {
  /** Writes the control's row; false when the id was already seen (a replay). */
  async function enqueueRow(
    input: { threadId: ThreadId; id: string; control: ControlBody },
    draft: MessageDraft,
  ): Promise<boolean> {
    const existing = await deps.findMessage(input.id);
    if (existing) {
      if (
        existing.threadId !== input.threadId ||
        existing.intent !== "control" ||
        !sameControl(existing.body as ControlBody, input.control)
      )
        throw new ThreadControlError(409, "control_id_conflict");
      return false;
    }
    if (input.control.kind === "compact") {
      if (!(await deps.hasCompletedReply(input.threadId)))
        throw new ThreadControlError(409, "compact_requires_completed_reply");
      await deps.enqueue(draft);
      return true;
    }
    const queued = queuedWriteModeSwitch(await deps.selectPending(input.threadId));
    const unchanged = queued
      ? queued.body.mode === input.control.mode
      : (await deps.threadWriteMode(input.threadId)) === input.control.mode;
    if (queued || unchanged) {
      // A switch back cancels the queued switch; a same-mode request leaves
      // things alone. Either way the row is written already acknowledged,
      // so nothing shows in the chat and a replay finds it settled.
      await deps.enqueueSettled(draft, queued && !unchanged ? [queued.id] : []);
      if (!unchanged) await deps.setWorkDefault(input.threadId, input.control.mode);
      return true;
    }
    await deps.enqueueWithoutWake(draft);
    await deps.setWorkDefault(input.threadId, input.control.mode);
    return true;
  }
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
      // One read under the lock: every switch transition commits under it, so
      // the mode and queue read at the end are the server's switch state as of `seq`.
      return deps.withThreadLock(input.threadId, async () => {
        const created = await enqueueRow(input, draft);
        const turn = await deps.findControlTurn(input.threadId, input.id);
        const pending = (await deps.pending(input.threadId)).items.find(isQueuedSwitch) ?? null;
        const mode = await deps.threadWriteMode(input.threadId);
        // Last, so it is at or past the frame of every transition read above.
        const seq = (await deps.headSeq(input.threadId)).toString();
        return {
          created,
          response: { id: input.id, pending, turnId: turn?.id ?? null, seq, mode },
        };
      });
    },
    async effectiveWriteMode(threadId) {
      const queued = queuedWriteModeSwitch(await deps.selectPending(threadId));
      return queued?.body.mode ?? (await deps.threadWriteMode(threadId));
    },
    withdrawControl: (threadId, controlId) =>
      deps.withThreadLock(threadId, async () => {
        const row = await deps.findMessage(controlId);
        if (row?.threadId !== threadId || row.intent !== "control")
          throw new ThreadControlError(404, "control_not_found");
        let outcome: WithdrawThreadControlResponse["outcome"] = "withdrawn";
        if (await deps.findControlTurn(threadId, controlId)) outcome = "already_started";
        else if (!row.deliveredAt) {
          await deps.acknowledge(threadId, [controlId]);
          // Withdrawing a pending switch is the writer's latest choice: the chat's own mode.
          if (row.body.kind === "write_mode")
            await deps.setWorkDefault(threadId, await deps.threadWriteMode(threadId));
        }
        // The ack's frame is appended inline above, so the queue and mode read here are the
        // switch state after the withdrawal; `seq` is read last, at or past that frame.
        const pending = (await deps.pending(threadId)).items.find(isQueuedSwitch) ?? null;
        const mode = await deps.threadWriteMode(threadId);
        return { outcome, pending, mode, seq: (await deps.headSeq(threadId)).toString() };
      }),
  };
}

function sameControl(left: ControlBody, right: ControlBody): boolean {
  if (left.kind === "compact")
    return right.kind === "compact" && left.instructions === right.instructions;
  return right.kind === "write_mode" && left.mode === right.mode;
}

function isQueuedSwitch(item: PendingInboxItem): boolean {
  return item.control?.kind === "write_mode";
}
