/**
 * Stateless tool dispatch step for the runtime loop.
 *
 * The orchestrator owns permission. This module runs the allowed call: live
 * output journal appends, spawn/returnResult callback wiring, and durable
 * tool_result persistence, which is also where a
 * result's shown-link candidates become evidence. Writer-facing
 * helper-result cards belong to spawn. return_result settlement (envelope,
 * tool_result + child-report, batch end) is spawn-owned. The caller supplies
 * current turn and block allocation state.
 */

import type { ReplyMutations } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ReturnResultCapture, TreeBudget } from "@meridian/contracts/spawn";
import type {
  Block,
  CurrentToolCall,
  OrchestratorEvent,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { readThreadActivity } from "../../threads/index.js";
import type { ObservationFrontiers } from "../ports/observation-frontiers.js";
import type { ShownLinkStore } from "../ports/shown-links.js";
import { appendSubagentActivityForToolChangeBestEffort } from "../spawn/activity-event.js";
import type { ChildRunCoordinator, ChildRunRequest } from "../spawn/child-run-coordinator.js";
import { readModelThreadReport } from "../spawn/model-thread-report.js";
import { persistReturnResult, type SpawnTranscript } from "../spawn/spawn-transcript.js";
import type {
  SpawnToolArgs,
  ThreadMessageArgs,
  ThreadReportArgs,
  ToolCallInput,
  ToolExecutor,
} from "../tools/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { createDeltaJournal } from "./delta-journal.js";
import { type CreditedBlocks, frontierLookup, recordFrontier } from "./frontier-recording.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";
import { toJsonValue } from "./streaming.js";

export interface ToolDispatchDeps {
  toolExecutor: ToolExecutor;
  childRunCoordinator: ChildRunCoordinator;
  eventSink: EventSink;
  persistenceDeps: PersistenceDeps;
  executionReports: import("../../threads/ports/repositories.js").ThreadRepositories["executionReports"];
  readSnapshot: import("../../threads/ports/repositories.js").ThreadRepositories["readSnapshot"];
  runClaim: Pick<import("./ports.js").RunClaim, "readMany" | "setCurrentTool">;
  shownLinks: Pick<ShownLinkStore, "record">;
  observationFrontiers: ObservationFrontiers;
  asks: import("../../threads/ports/ask-repository.js").AskRepository;
  askRequests: Pick<import("../asks/ask-service.js").AskService, "request">;
}

/**
 * One provider batch's request rule, keyed on what a call asks for, not on which tool:
 * the first request defers the batch and a later one is refused, as is any request beside a
 * `return_result`. A `thread_message` to a child whose question this batch forwards goes
 * unbound, so it never answers the question going to the writer.
 */
export type RequestBatch = {
  readonly hasReturnResult: boolean;
  readonly forwarding: ReadonlySet<string>;
  deferred: string | null;
};

export function requestBatch(calls: readonly ToolCallInput[]): RequestBatch {
  return {
    hasReturnResult: calls.some((call) => call.name === "return_result"),
    forwarding: new Set(
      calls.flatMap((call) =>
        typeof call.arguments.forward === "string" ? [call.arguments.forward] : [],
      ),
    ),
    deferred: null,
  };
}

export interface ToolDispatchContext {
  thread: Thread;
  lease: import("./ports.js").Lease;
  agentSlug: string | null;
  responseId: string;
  /** Agent-edit lifecycle scope; rotates at an in-response Work switch. */
  editResponseId?: string;
  threadId: ThreadId;
  currentTurn: Turn;
  signal?: AbortSignal;
  allBlocks: Block[];
  treeBudget: TreeBudget;
  blockSeqRef: { value: number };
  allTurns: Turn[];
  /** The ids that credited the request that produced this call (C4's planning cut). */
  planningBlockIds: readonly string[];
  /** Latest still-open child question whose structured evidence was in this request. */
  boundChildQuestions?: ReadonlyMap<string, string>;
  batch: RequestBatch;
  /** The provider reply's own accepted mutations, replayed after the planning cut. */
  replyMutations: ReplyMutations;
  /** The run's credited ids, live: a sibling call's result counts as seen. */
  credited: CreditedBlocks;
}

export type CompletedToolOutcome = {
  kind: "completed";
  block: Block;
  metadata?: Record<string, unknown>;
  /** Successful return_result ends the batch and completes the turn. */
  end?: { cause: "success" };
};

export type ToolDispatchOutcome =
  | CompletedToolOutcome
  /** Reserved for durable tools whose result is written after this execution settles. */
  | { kind: "deferred"; askId: string };

export type ToolDispatchResult = ToolDispatchOutcome | { kind: "cancelled" };

export type BatchDisposition =
  | { kind: "continue" }
  | { kind: "end"; cause: "success" }
  | { kind: "end"; cause: "asked"; askId: string };

/** Reduce once per provider batch, rejecting competing batch-ending outcomes. */
export function reduceToolBatch(outcomes: readonly ToolDispatchOutcome[]): BatchDisposition {
  let disposition: BatchDisposition = { kind: "continue" };
  for (const outcome of outcomes) {
    if (outcome.kind === "deferred") {
      if (disposition.kind === "end") throw new Error("Only one batch-ending tool call is allowed");
      disposition = { kind: "end", cause: "asked", askId: outcome.askId };
      continue;
    }
    if (!outcome.end) continue;
    if (disposition.kind === "end") throw new Error("Only one batch-ending tool call is allowed");
    disposition = { kind: "end", cause: outcome.end.cause };
  }
  return disposition;
}

export async function dispatchToolCall(
  deps: ToolDispatchDeps,
  call: ToolCallInput,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  await deps.persistenceDeps.eventWriter.appendEvents(ctx.threadId, [
    {
      type: "tool.executing",
      toolCallId: call.id,
      name: call.name,
    },
  ]);
  if (ctx.signal?.aborted) {
    return { kind: "cancelled" };
  }

  if (ctx.thread.kind === "subagent") {
    const currentTool: CurrentToolCall = {
      toolCallId: call.id,
      toolName: call.name,
      input: toJsonValue(call.arguments),
    };
    await appendSubagentActivityForToolChangeBestEffort({
      recordCurrentTool: () => deps.runClaim.setCurrentTool(ctx.lease, currentTool),
      currentTool,
      eventWriter: deps.persistenceDeps.eventWriter,
      readActivity: (threadId) =>
        readThreadActivity(
          {
            threads: deps.persistenceDeps.repos.threads,
            statusReader: deps.runClaim,
            executionReports: deps.executionReports,
          },
          threadId,
        ),
      parentThreadId: ctx.thread.parentThreadId as ThreadId,
      childThreadId: ctx.thread.id,
      eventSink: deps.eventSink,
    });
  }

  const outputJournal = createDeltaJournal({
    threadId: ctx.threadId,
    appendEvents: (threadId, events) =>
      deps.persistenceDeps.eventWriter.appendEvents(threadId, events),
    eventSink: deps.eventSink,
    scope: "tool_call",
  });
  let outputDropped = false;
  const dropOutput = (reason: "budget_full" | "write_failed", failure?: { cause: unknown }) => {
    if (outputDropped) return;
    outputDropped = true;
    outputJournal.seal();
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.orchestrator",
      name: "tool_output_delta.dropped",
      correlation: {
        threadId: ctx.threadId,
        turnId: ctx.currentTurn.id,
        runId: ctx.currentTurn.id,
        toolName: call.name,
      },
      payload: {
        threadId: ctx.threadId,
        turnId: ctx.currentTurn.id,
        reason,
        ...(failure ? unknownToEventPayload(failure.cause) : {}),
      },
    });
  };
  const drainOutput = async () => {
    try {
      await outputJournal.flush();
    } catch (cause) {
      dropOutput("write_failed", { cause });
    }
  };
  const emitOutputDelta = (
    toolCallId: string,
    chunk: { stream: "stdout" | "stderr"; text: string },
  ) => {
    const event: OrchestratorEvent = {
      type: "tool.output_delta",
      toolCallId,
      stream: chunk.stream,
      text: chunk.text,
    };
    const admission = outputJournal.tryPush(event);
    if (admission.status === "full") {
      dropOutput("budget_full");
    } else if (admission.status === "failed") {
      dropOutput("write_failed", admission);
    }
  };

  const transcript: SpawnTranscript = {
    persistence: deps.persistenceDeps,
    threadId: ctx.threadId,
    turnId: ctx.currentTurn.id,
    blockSeqRef: ctx.blockSeqRef,
    allBlocks: ctx.allBlocks,
  };

  const spawn =
    call.name === "spawn"
      ? async (spawnInput: SpawnToolArgs) => {
          await drainOutput();
          const request: ChildRunRequest = {
            kind: "spawn",
            parentThread: ctx.thread,
            parentTurnId: ctx.currentTurn.id,
            agentSlug: spawnInput.agent,
            prompt: spawnInput.prompt,
            from: spawnInput.from,
            name: spawnInput.name,
            ...(spawnInput.append_system_prompt !== undefined
              ? { appendSystemPrompt: spawnInput.append_system_prompt }
              : {}),
            ...(spawnInput.overrides !== undefined ? { overrides: spawnInput.overrides } : {}),
            budget: ctx.treeBudget,
            reportCorrelation: {
              callerThreadId: ctx.thread.id,
              callerTurnId: ctx.currentTurn.id,
              toolCallId: call.id,
              cardBlockId: null,
              origin: "spawn",
              deliveryMode: spawnInput.mode === "background" ? "background_notification" : "direct",
            },
            signal: ctx.signal,
          };
          return deps.childRunCoordinator.runChild(request, {
            mode: spawnInput.mode,
            transcript,
          });
        }
      : undefined;

  const boundAsk = (ref: string) => {
    const askId = ctx.boundChildQuestions?.get(ref);
    return askId && !ctx.batch.forwarding.has(askId) ? askId : undefined;
  };
  const threadMessage =
    call.name === "thread_message"
      ? async (messageInput: ThreadMessageArgs) => {
          if (messageInput.mode === "foreground") await drainOutput();
          const request: ChildRunRequest = {
            kind: "message",
            parentThread: ctx.thread,
            parentTurnId: ctx.currentTurn.id,
            ref: messageInput.ref,
            prompt: messageInput.message,
            toolCallId: call.id,
            ...(boundAsk(messageInput.ref) ? { boundAskId: boundAsk(messageInput.ref) } : {}),
            budget: ctx.treeBudget,
            ...(messageInput.mode === "foreground"
              ? {
                  reportCorrelation: {
                    callerThreadId: ctx.thread.id,
                    callerTurnId: ctx.currentTurn.id,
                    toolCallId: call.id,
                    cardBlockId: null,
                    origin: "message" as const,
                    deliveryMode: "direct" as const,
                  },
                }
              : {}),
            signal: ctx.signal,
          };
          return deps.childRunCoordinator.runChild(request, {
            mode: messageInput.mode,
            ...(messageInput.mode === "foreground" ? { transcript } : {}),
          });
        }
      : undefined;

  const threadReport =
    call.name === "thread_report"
      ? (reportInput: ThreadReportArgs) =>
          readModelThreadReport({
            callerThreadId: ctx.thread.id as never,
            ref: reportInput.ref,
            repos: {
              threads: deps.persistenceDeps.repos.threads,
              turns: deps.persistenceDeps.repos.turns,
              executionReports: deps.executionReports,
              asks: deps.asks,
              readSnapshot: deps.readSnapshot,
            },
          })
      : undefined;

  let deferredAskId: string | null = null;
  const request = async (
    asked: import("../asks/ask-service.js").AskRequest,
  ): Promise<import("../asks/ask-service.js").AskRequestOutcome> => {
    const refused = ctx.batch.hasReturnResult
      ? "You returned a result; there's no one left to answer."
      : ctx.batch.deferred
        ? "One request at a time: make this one after the answer arrives."
        : null;
    if (refused) return { kind: "refused", refusal: { code: "request_refused", reason: refused } };
    const outcome = await deps.askRequests.request({
      threadId: ctx.threadId,
      askingTurnId: ctx.currentTurn.id,
      executionId: ctx.lease.executionId,
      toolCallId: call.id,
      request: asked,
    });
    if (outcome.kind === "deferred") {
      ctx.batch.deferred = outcome.askId;
      deferredAskId = outcome.askId;
    }
    return outcome;
  };

  let returnResultCapture: ReturnResultCapture | undefined;
  const returnResult = async (capture: ReturnResultCapture) => {
    if (ctx.thread.kind !== "subagent") {
      return { ok: false as const, message: "return_result is not available on this run." };
    }
    returnResultCapture = capture;
    return { ok: true as const };
  };

  const correlation = { threadId: ctx.threadId, turnId: ctx.currentTurn.id };
  const execResult = await deps.toolExecutor.executeTool(
    {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      ...(call.argumentsParseError ? { argumentsParseError: call.argumentsParseError } : {}),
    },
    {
      threadId: ctx.threadId,
      turnId: ctx.currentTurn.id,
      responseIdentity: {
        providerResponseId: ctx.responseId,
        editScopeId: ctx.editResponseId ?? ctx.responseId,
      },
      agentSlug: ctx.agentSlug,
      signal: ctx.signal,
      emitOutputDelta,
      spawn,
      threadMessage,
      threadReport,
      returnResult,
      request,
      frontiers: {
        recording: frontierLookup(deps, () => ctx.credited.ids(), correlation),
        planning: frontierLookup(deps, () => ctx.planningBlockIds, correlation),
        reply: ctx.replyMutations,
      },
    },
  );
  outputJournal.seal();
  await drainOutput();
  if (ctx.signal?.aborted) {
    return { kind: "cancelled" };
  }

  // A created ask settles the execution, whatever the tool did after asking.
  if (deferredAskId) return { kind: "deferred", askId: deferredAskId };

  const stagedWrite = execResult.metadata?.stagedWrite === true && execResult.isError !== true;
  if (execResult.returnResult) {
    const settled = await persistReturnResult(transcript, {
      toolCallId: execResult.toolCallId,
      outcome: execResult.returnResult,
      capture: returnResultCapture,
      executionReports: deps.executionReports,
    });
    return {
      kind: "completed",
      block: settled.block,
      ...(settled.endsBatch ? { end: { cause: "success" as const } } : {}),
    };
  }
  const persistedOutput = execResult.output;
  const persistedIsError = execResult.isError;
  const persistedMetadata = execResult.metadata;
  const persistedResult = execResult.result;

  const persistedToolResult = await persistAndAppendEvents(
    deps.persistenceDeps,
    ctx.threadId,
    async () => {
      const block = contentForBlockInput({
        turnId: ctx.currentTurn.id,
        ...(stagedWrite ? { responseId: ctx.responseId } : {}),
        blockType: "tool_result",
        sequence: ctx.blockSeqRef.value++,
        content: {
          toolCallId: execResult.toolCallId,
          output: persistedOutput,
          result: persistedResult,
          ...(persistedIsError !== undefined ? { isError: persistedIsError } : {}),
          ...(persistedMetadata ? { metadata: persistedMetadata } : {}),
        },
        status: "complete",
      });
      return {
        result: localBlockFromEvent(block),
        events: [
          { type: "block.upserted", block },
          {
            type: "tool.result",
            toolCallId: execResult.toolCallId,
            output: persistedOutput,
            result: persistedResult,
            isError: persistedIsError,
            ...(persistedMetadata ? { metadata: persistedMetadata } : {}),
          },
        ],
      };
    },
    {
      // The model is shown exactly the result persisted here, so its evidence commits with
      // it, after the block row exists (the frontier references it); a cancelled or timed-out
      // call never reaches this point.
      afterEvents: async (block) => {
        const evidence = execResult.evidence;
        if (!evidence) return;
        const owner = { threadId: ctx.threadId, turnId: block.turnId };
        for (const showing of evidence.shown)
          await deps.shownLinks.record({ ...showing, ...owner });
        if (evidence.frontier) await recordFrontier(deps, block.id, evidence.frontier, owner);
      },
    },
  );
  ctx.allBlocks.push(persistedToolResult.result);
  ctx.credited.add(persistedToolResult.result.id);

  const resultBlock = persistedToolResult.result;
  const resultMetadata = execResult.metadata;
  return {
    kind: "completed",
    block: resultBlock,
    ...(resultMetadata
      ? {
          metadata: {
            ...resultMetadata,
          },
        }
      : {}),
  };
}
