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
import { testHook } from "../../../shared/test-hooks.js";
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
              readSnapshot: deps.readSnapshot,
            },
          })
      : undefined;

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

  if (call.name === "ask" && execResult.isError !== true) {
    const ask = await deps.asks.create({
      threadId: ctx.threadId,
      askingTurnId: ctx.currentTurn.id,
      executionId: ctx.lease.executionId,
      toolCallId: call.id,
      kind: "question",
      payload: execResult.result as import("@meridian/contracts/threads").QuestionAskPayload,
      deadlineAt: null,
      status: "pending",
      resolution: null,
      submissionId: null,
    });
    await testHook("ask.pending");
    return { kind: "deferred", askId: ask.id };
  }

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
