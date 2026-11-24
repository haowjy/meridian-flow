import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation } from "@meridian/contracts/spawn";
import type { Thread } from "@meridian/contracts/threads";
import { isContinuationOwed } from "../../../shared/ask-continuation-owed.js";
import type { StoredAsk, ThreadRepositories } from "../../threads/index.js";
import type { AskResolvedBody, InboxMessage } from "../loop/ports.js";
import type { RunLoopInput } from "../loop/run-turn-port.js";

export type ResolvedContinuation = { ask: StoredAsk };

const THREAD_RUN_CORRELATION = {
  callerThreadId: null,
  callerTurnId: null,
  toolCallId: null,
  cardBlockId: null,
  origin: "thread_run" as const,
  deliveryMode: "none" as const,
};

export async function readContinuation(
  asks: Pick<ThreadRepositories["asks"], "findById">,
  threadId: ThreadId,
  hint: AskResolvedBody,
): Promise<ResolvedContinuation | "retire"> {
  const ask = await asks.findById(hint.askId);
  if (ask?.threadId !== threadId)
    throw new Error("Ask continuation is not backed by this thread's ask");
  if (!isContinuationOwed(ask)) return "retire";
  return { ask };
}

export async function admitRun(
  repos: Pick<ThreadRepositories, "asks" | "executionReports">,
  input: {
    thread: Thread;
    executionTurnId: TurnId;
    adopted: readonly InboxMessage[];
    continuation: ResolvedContinuation | null;
    executionReport?: RunLoopInput["executionReport"];
  },
): Promise<void> {
  const { thread, continuation } = input;
  const threadId = thread.id as ThreadId;
  if (
    continuation &&
    !(await repos.asks.admitContinuation({
      id: continuation.ask.id,
      turnId: input.executionTurnId,
    }))
  )
    throw new Error("Ask continuation is no longer owed");
  if (thread.kind !== "subagent" && input.executionReport) {
    throw new Error("Execution report correlation requires a subagent thread");
  }
  if (thread.kind !== "subagent") return;
  if (!thread.ref) throw new Error("Subagent thread has no project handle");
  const correlation =
    input.executionReport?.correlation ??
    parentRetaskCorrelation(thread, input.adopted) ??
    THREAD_RUN_CORRELATION;
  await repos.executionReports.admit({
    childThreadId: threadId,
    executionTurnId: input.executionTurnId,
    handle: thread.ref,
    ...correlation,
    agentSlug: input.executionReport?.agentSlug ?? null,
    name: input.executionReport?.name ?? null,
  });
}

function parentRetaskCorrelation(
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
