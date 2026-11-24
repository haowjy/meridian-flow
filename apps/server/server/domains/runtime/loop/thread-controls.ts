import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  ControlBody,
  RunState,
  Turn,
  WithdrawThreadControlResponse,
} from "@meridian/contracts/threads";
import { type AiWriteMode, effectiveAiWriteMode } from "@meridian/contracts/works";
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
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  enqueueWithoutWake(draft: MessageDraft): Promise<InboxMessage>;
  enqueueSettled(draft: MessageDraft, cancelledIds: readonly string[]): Promise<void>;
  selectPending(threadId: ThreadId): Promise<InboxMessage[]>;
  threadWriteMode(threadId: ThreadId): Promise<AiWriteMode>;
  setWorkDefault(threadId: ThreadId, mode: AiWriteMode): Promise<void>;
  findControlTurn(threadId: ThreadId, controlId: string): Promise<Turn | null>;
  answerRunState(threadId: ThreadId): Promise<RunState>;
  acknowledge(threadId: ThreadId, ids: readonly string[]): Promise<void>;
  hasCompletedReply(threadId: ThreadId): Promise<boolean>;
}): ThreadControls {
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
      await deps.enqueueSettled(draft, queued && !unchanged ? [queued.id] : []);
      return true;
    }
    await deps.enqueueWithoutWake(draft);
    return true;
  }
  return {
    async enqueueControl(input) {
      const draft: MessageDraft = {
        id: input.id,
        threadId: input.threadId,
        intent: "control",
        body: input.control,
        provenance: input.provenance,
        idempotencyKey: input.id,
      };
      return deps.withThreadLock(input.threadId, async () => {
        const created = await enqueueRow(input, draft);
        if (created && input.control.kind === "write_mode" && input.provenance.kind === "writer")
          await deps.setWorkDefault(input.threadId, input.control.mode);
        const turn = await deps.findControlTurn(input.threadId, input.id);
        const runState = await deps.answerRunState(input.threadId);
        return { created, response: { id: input.id, turnId: turn?.id ?? null, runState } };
      });
    },
    async effectiveWriteMode(threadId) {
      const queued = queuedWriteModeSwitch(await deps.selectPending(threadId));
      return effectiveAiWriteMode(await deps.threadWriteMode(threadId), queued?.body.mode ?? null);
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
          if (row.body.kind === "write_mode")
            await deps.setWorkDefault(threadId, await deps.threadWriteMode(threadId));
        }
        return { outcome, runState: await deps.answerRunState(threadId) };
      }),
  };
}

function sameControl(left: ControlBody, right: ControlBody): boolean {
  if (left.kind === "compact")
    return right.kind === "compact" && left.instructions === right.instructions;
  return right.kind === "write_mode" && left.mode === right.mode;
}
