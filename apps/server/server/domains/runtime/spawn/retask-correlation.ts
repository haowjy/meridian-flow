/** Report correlation for a subagent run woken by its parent's background re-task. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation } from "@meridian/contracts/spawn";
import type { Thread } from "@meridian/contracts/threads";
import type { InboxMessage } from "../loop/ports.js";

/**
 * A run woken by its parent's background `thread_message` reports back to that
 * parent like a background spawn. The latest re-task in the adopted batch names
 * the invocation; messages from any other thread start an ordinary thread run.
 */
export function parentRetaskCorrelation(
  thread: Thread,
  adopted: readonly InboxMessage[],
): ExecutionReportCorrelation | null {
  for (const message of [...adopted].reverse()) {
    const provenance = message.provenance;
    if (
      message.intent === "message" &&
      provenance.kind === "agent" &&
      provenance.notify &&
      provenance.threadId === thread.parentThreadId
    ) {
      return {
        callerThreadId: provenance.threadId as ThreadId,
        callerTurnId: provenance.notify.turnId as TurnId,
        toolCallId: provenance.notify.toolCallId,
        cardBlockId: null,
        origin: "message",
        deliveryMode: "background_notification",
      };
    }
  }
  return null;
}
