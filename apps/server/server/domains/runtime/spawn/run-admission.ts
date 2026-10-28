/**
 * A subagent run's admission at its reservation commit: which invocation its report
 * belongs to (the parent call, a continued question's original call, a parent's
 * background re-task, or none), and, for a run that continues a resolved ask, the
 * ask's continuation claim.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation } from "@meridian/contracts/spawn";
import type { QuestionAskPayload, Thread } from "@meridian/contracts/threads";
import type { StoredAsk, ThreadRepositories } from "../../threads/index.js";
import type { AskResolvedBody, InboxMessage } from "../loop/ports.js";
import type { RunLoopInput } from "../loop/run-turn-port.js";

/** The resolved ask a drain run continues, from its `ask_resolved` wake hint. */
export type ResolvedContinuation = {
  ask: StoredAsk;
  delivery: AskResolvedBody["delivery"];
  /** A forwarded ask's continuation relays the answer before its first request. */
  forwarded: boolean;
};

const THREAD_RUN_CORRELATION = {
  callerThreadId: null,
  callerTurnId: null,
  toolCallId: null,
  cardBlockId: null,
  origin: "thread_run" as const,
  deliveryMode: "none" as const,
};

/**
 * What a run-start hint continues. `retire`: its ask owes nothing more (a redelivered
 * row), so it is acknowledged and no turn starts. A continuation's state never
 * returns to owed, so this read needs no lock; admission claims it under the lock.
 */
export async function readContinuation(
  asks: Pick<ThreadRepositories["asks"], "findById">,
  threadId: ThreadId,
  hint: AskResolvedBody,
): Promise<ResolvedContinuation | "retire"> {
  const ask = await asks.findById(hint.askId);
  if (ask?.threadId !== threadId)
    throw new Error("Ask continuation is not backed by this thread's ask");
  if (ask.continuation !== "pending" && ask.continuation !== "admitted") return "retire";
  return {
    ask,
    delivery: hint.delivery,
    forwarded: ask.kind === "question" && !!(ask.payload as QuestionAskPayload).forwardedFrom,
  };
}

/**
 * Admits a run in its reservation commit: claims the continuation it runs (the thread
 * lock already holds the ask's row), then records a subagent run's report correlation.
 */
export async function admitRun(
  repos: Pick<ThreadRepositories, "asks" | "executionReports" | "threads">,
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
      forwarded: continuation.forwarded,
    }))
  )
    throw new Error("Ask continuation is no longer owed");
  if (thread.kind !== "subagent" && input.executionReport) {
    throw new Error("Execution report correlation requires a subagent thread");
  }
  if (thread.kind !== "subagent") return;
  if (!thread.ref) throw new Error("Subagent thread has no project handle");
  // A continuation belongs to the asked execution's invocation; the hint says
  // whether a waiting parent call or a notification delivers its report.
  const asking = continuation
    ? await repos.executionReports.findByTurn(threadId, continuation.ask.askingTurnId)
    : null;
  const inherited =
    asking && continuation
      ? asking.deliveryMode === "none"
        ? THREAD_RUN_CORRELATION
        : {
            callerThreadId: asking.callerThreadId,
            callerTurnId: asking.callerTurnId,
            toolCallId: asking.toolCallId,
            cardBlockId: asking.cardBlockId,
            origin: asking.origin,
            deliveryMode: continuation.delivery,
          }
      : null;
  const correlation =
    input.executionReport?.correlation ??
    inherited ??
    parentRetaskCorrelation(thread, input.adopted) ??
    THREAD_RUN_CORRELATION;
  await repos.executionReports.admit({
    childThreadId: threadId,
    executionTurnId: input.executionTurnId,
    handle: thread.ref,
    ...correlation,
    agentSlug: input.executionReport?.agentSlug ?? asking?.agentSlug ?? null,
    name: input.executionReport?.name ?? asking?.name ?? null,
  });
  if (asking?.origin === "spawn")
    await repos.threads.updateSpawnLifecycle(threadId, { spawnStatus: "running" });
}

/**
 * A run woken by its parent's background `thread_message` reports back to that
 * parent like a background spawn. The latest re-task in the adopted batch names
 * the invocation; messages from any other thread start an ordinary thread run.
 */
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
