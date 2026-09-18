/**
 * Stateless tool dispatch step for the runtime loop.
 *
 * The orchestrator owns permission. This module runs the allowed call: live
 * output journal appends, spawn and return-result bridges, interrupt callback
 * wiring, and durable tool_result persistence. The caller supplies mutable
 * turn/block state so interrupt callbacks can update the active turn while the
 * tool handler is awaited.
 */

import {
  buildChildReportComponentContent,
  buildHelperResultComponentContent,
} from "@meridian/contracts/components";
import type { TreeBudget } from "@meridian/contracts/spawn";
import type {
  Block,
  JsonObject,
  JsonValue,
  OrchestratorEvent,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { WorkContextDelivery } from "../../projects/index.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import { spawnHelperCardProps, spawnOutputForTranscript } from "../spawn/spawn-output.js";
import type { ToolCallInput, ToolExecutionResult, ToolExecutor } from "../tools/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import type { InterruptSession, InterruptTurnState } from "./interrupt-session.js";
import type { InterruptAutoResumePolicy } from "./interrupts.js";
import { appendEvent, type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";
import type { ReturnResultCompleter } from "./run-turn-port.js";

export interface ToolDispatchDeps {
  toolExecutor: ToolExecutor;
  childRunCoordinator: ChildRunCoordinator;
  eventSink: EventSink;
  persistenceDeps: PersistenceDeps;
  workContextDelivery: Pick<WorkContextDelivery, "deliverNow">;
}

export interface ToolDispatchContext {
  thread: Thread;
  agentSlug: string | null;
  responseId: string;
  /** Agent-edit lifecycle scope; rotates at an in-response Work switch. */
  editResponseId?: string;
  state: InterruptTurnState;
  interruptSession: InterruptSession;
  interruptAutoResume: InterruptAutoResumePolicy;
  treeBudget: TreeBudget;
  blockSeqRef: { value: number };
  returnResultCompleter?: ReturnResultCompleter;
  allTurns: Turn[];
}

export type ToolDispatchResult =
  | {
      events: OrchestratorEvent[];
      block: Block;
      metadata?: Record<string, unknown>;
      cancelled?: false;
      /** Successful return_result asks the orchestrator to complete the turn after this batch. */
      endTurn?: true;
    }
  | { events: OrchestratorEvent[]; cancelled: true };

function pendingWorkContextOutput(output: JsonValue, message: string): JsonObject {
  const result =
    output !== null && typeof output === "object" && !Array.isArray(output)
      ? output
      : { result: output };
  return {
    ...result,
    contextUpdate: { status: "pending", message },
  };
}

export async function dispatchToolCall(
  deps: ToolDispatchDeps,
  call: ToolCallInput,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  const events: OrchestratorEvent[] = [];
  const executing = await appendEvent(deps.persistenceDeps.eventWriter, ctx.state.threadId, {
    type: "tool.executing",
    toolCallId: call.id,
    name: call.name,
  });
  events.push(executing);
  if (ctx.state.signal?.aborted) {
    return { events, cancelled: true };
  }

  const outputDeltaEventBuffer: OrchestratorEvent[] = [];
  let outputDeltaAppendChain: Promise<void> = Promise.resolve();
  let outputDeltaAppendFailed = false;
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
    // Tool-output callbacks run while the generator is blocked inside
    // `await executeTool(...)`. Append immediately for hub fan-out, but
    // serialize appends so journal/catch-up order matches chunk order; the
    // buffer is yielded once the handler returns, before tool.result.
    outputDeltaAppendChain = outputDeltaAppendChain
      .then(async () => {
        if (outputDeltaAppendFailed) return;
        await appendEvent(deps.persistenceDeps.eventWriter, ctx.state.threadId, event);
        outputDeltaEventBuffer.push(event);
      })
      .catch((error: unknown) => {
        outputDeltaAppendFailed = true;
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.orchestrator",
          name: "tool_output_delta.append_failed",
          correlation: {
            threadId: ctx.state.threadId,
            turnId: ctx.state.currentTurn.id,
            runId: ctx.state.currentTurn.id,
            toolName: call.name,
          },
          payload: {
            threadId: ctx.state.threadId,
            turnId: ctx.state.currentTurn.id,
            ...unknownToEventPayload(error),
          },
        });
      });
  };

  const spawn =
    call.name === "spawn"
      ? async (spawnInput: {
          agent?: string;
          prompt: string;
          description?: string;
          mode?: "foreground" | "background";
        }) =>
          deps.childRunCoordinator[
            spawnInput.mode === "background" ? "spawnChildBackground" : "spawnChild"
          ]({
            parentThread: ctx.thread,
            parentTurnId: ctx.state.currentTurn.id,
            agentSlug: spawnInput.agent,
            prompt: spawnInput.prompt,
            description: spawnInput.description,
            budget: ctx.treeBudget,
            signal: ctx.state.signal,
          })
      : undefined;

  const returnResultCompleter = ctx.returnResultCompleter;
  const returnResult = returnResultCompleter
    ? async (capture: Parameters<ReturnResultCompleter>[0]) => returnResultCompleter(capture)
    : undefined;

  const spawnArgs = spawnCallFields(call.arguments);
  const spawnCardOnTurn = call.name === "spawn" && spawnArgs.mode !== "background";
  let spawnCard: Block | null = null;
  if (spawnCardOnTurn) {
    spawnCard = await persistSpawnHelperCard(deps, ctx, events, {
      agent: spawnArgs.agent,
      description: spawnArgs.description,
      parentTurnId: ctx.state.currentTurn.id,
    });
  }

  const execResult = await deps.toolExecutor.executeTool(
    {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      ...(call.argumentsParseError ? { argumentsParseError: call.argumentsParseError } : {}),
    },
    {
      threadId: ctx.state.threadId,
      turnId: ctx.state.currentTurn.id,
      responseId: ctx.editResponseId ?? ctx.responseId,
      agentSlug: ctx.agentSlug,
      signal: ctx.state.signal,
      interruptTimeoutMs: ctx.interruptAutoResume.timeoutMs,
      emitOutputDelta,
      interrupt: ctx.interruptSession.interrupt,
      updateComponentBlock: ctx.interruptSession.updateComponentBlock,
      spawn,
      returnResult,
    },
  );
  await outputDeltaAppendChain;
  events.push(...outputDeltaEventBuffer, ...ctx.interruptSession.drainEvents());
  if (ctx.state.signal?.aborted) {
    return { events, cancelled: true };
  }

  const stagedWrite = execResult.metadata?.stagedWrite === true && execResult.isError !== true;
  const isReturnResult = call.name === "return_result";
  // A return_result turn always answers with a normalized completion envelope:
  // `{ ok: true }` or `{ ok: false, message }`. Anything else (missing completer,
  // already returned, handler throw) is a model-facing failure.
  const returnResultError = isReturnResult
    ? returnResultErrorFor(execResult, Boolean(returnResultCompleter))
    : null;
  const persistedOutput: JsonValue = isReturnResult
    ? returnResultError === null
      ? { ok: true }
      : { ok: false, message: returnResultError }
    : call.name === "spawn"
      ? spawnOutputForTranscript(execResult.output)
      : execResult.output;
  const persistedIsError = isReturnResult ? returnResultError !== null : execResult.isError;
  const persistedMetadata = execResult.metadata;
  // A settled spawn stays on the frontier, so the durable result must name its
  // tool for `block-kind.ts` to find it without pairing back to the tool_use.
  const persistedToolName: Record<string, JsonValue> =
    call.name === "spawn" ? { toolName: call.name } : {};

  const persistedToolResult = await persistAndAppendEvents(
    deps.persistenceDeps,
    ctx.state.threadId,
    async () => {
      const block = contentForBlockInput({
        turnId: ctx.state.currentTurn.id,
        ...(stagedWrite ? { responseId: ctx.responseId } : {}),
        blockType: "tool_result",
        sequence: ctx.blockSeqRef.value++,
        content: {
          toolCallId: execResult.toolCallId,
          ...persistedToolName,
          output: persistedOutput,
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
            isError: persistedIsError,
            ...(persistedMetadata ? { metadata: persistedMetadata } : {}),
          },
        ],
      };
    },
  );
  ctx.state.allBlocks.push(persistedToolResult.result);
  events.push(...persistedToolResult.events);
  if (isReturnResult && returnResultError === null) {
    await persistChildReportCard(deps, ctx, events, {
      summary: returnResultSummary(call.arguments),
    });
  }
  if (spawnCardOnTurn && spawnCard) {
    await persistSpawnHelperCard(
      deps,
      ctx,
      events,
      {
        agent: spawnArgs.agent,
        description: spawnArgs.description,
        parentTurnId: ctx.state.currentTurn.id,
        output: persistedOutput,
      },
      spawnCard,
    );
  }
  let resultBlock = persistedToolResult.result;
  let resultMetadata = execResult.metadata;
  if (execResult.metadata?.workContextChanged === true) {
    try {
      const update = await deps.workContextDelivery.deliverNow(ctx.state.threadId);
      ctx.allTurns.push(update.turn);
      ctx.state.allBlocks.push(update.block);
      events.push(...update.events);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Work context refresh will retry after this turn.";
      const output = pendingWorkContextOutput(execResult.output, message);
      const metadata: JsonObject = {
        ...execResult.metadata,
        workContextDelivery: "pending",
        workContextWarning: message,
      };
      const patched = await persistAndAppendEvents(
        deps.persistenceDeps,
        ctx.state.threadId,
        async () => {
          const block = contentForBlockInput({
            id: persistedToolResult.result.id,
            turnId: ctx.state.currentTurn.id,
            ...(stagedWrite ? { responseId: ctx.responseId } : {}),
            blockType: "tool_result",
            sequence: persistedToolResult.result.sequence,
            content: {
              toolCallId: execResult.toolCallId,
              output,
              ...(persistedIsError !== undefined ? { isError: persistedIsError } : {}),
              metadata,
            },
            status: "complete",
          });
          return {
            result: localBlockFromEvent(block),
            events: [
              { type: "block.upserted" as const, block },
              {
                type: "tool.result" as const,
                toolCallId: execResult.toolCallId,
                output,
                isError: persistedIsError,
                metadata,
              },
            ],
          };
        },
      );
      const blockIndex = ctx.state.allBlocks.findIndex((block) => block.id === patched.result.id);
      if (blockIndex >= 0) ctx.state.allBlocks[blockIndex] = patched.result;
      resultBlock = patched.result;
      resultMetadata = metadata;
      events.push(...patched.events);
    }
  }
  return {
    events,
    block: resultBlock,
    ...(resultMetadata
      ? {
          metadata: {
            ...resultMetadata,
          },
        }
      : {}),
    ...(isReturnResult && returnResultError === null ? { endTurn: true as const } : {}),
  };
}

/** Resolves the model-facing failure message for a return_result dispatch, or null on success. */
function returnResultErrorFor(result: ToolExecutionResult, hasCompleter: boolean): string | null {
  if (!hasCompleter) return "return_result is not available on this run.";
  if (result.isError === true) {
    return errorMessage(result.output) ?? "return_result failed.";
  }
  const output = result.output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (record.ok === false) {
      return typeof record.message === "string" ? record.message : "return_result failed.";
    }
  }
  return null;
}

function errorMessage(output: JsonValue): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const message = (output as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

function returnResultSummary(args: Record<string, unknown>): string {
  return typeof args.summary === "string" ? args.summary : "";
}

async function persistChildReportCard(
  deps: ToolDispatchDeps,
  ctx: ToolDispatchContext,
  events: OrchestratorEvent[],
  input: { summary: string },
): Promise<Block> {
  const persisted = await persistAndAppendEvents(
    deps.persistenceDeps,
    ctx.state.threadId,
    async () => {
      const block = contentForBlockInput({
        turnId: ctx.state.currentTurn.id,
        blockType: "custom",
        sequence: ctx.blockSeqRef.value++,
        content: buildChildReportComponentContent(input),
        status: "complete",
      });
      return {
        result: localBlockFromEvent(block),
        events: [{ type: "block.upserted" as const, block }],
      };
    },
  );
  ctx.state.allBlocks.push(persisted.result);
  events.push(...persisted.events);
  return persisted.result;
}

async function persistSpawnHelperCard(
  deps: ToolDispatchDeps,
  ctx: ToolDispatchContext,
  events: OrchestratorEvent[],
  input: Parameters<typeof spawnHelperCardProps>[0],
  existing?: Block | null,
): Promise<Block> {
  const persisted = await persistAndAppendEvents(
    deps.persistenceDeps,
    ctx.state.threadId,
    async () => {
      const block = contentForBlockInput({
        ...(existing ? { id: existing.id } : {}),
        turnId: ctx.state.currentTurn.id,
        blockType: "custom",
        sequence: existing?.sequence ?? ctx.blockSeqRef.value++,
        content: buildHelperResultComponentContent(spawnHelperCardProps(input)),
        status: "complete",
      });
      return {
        result: localBlockFromEvent(block),
        events: [{ type: "block.upserted" as const, block }],
      };
    },
  );
  if (existing) {
    const index = ctx.state.allBlocks.findIndex((block) => block.id === existing.id);
    if (index >= 0) ctx.state.allBlocks[index] = persisted.result;
    else ctx.state.allBlocks.push(persisted.result);
  } else {
    ctx.state.allBlocks.push(persisted.result);
  }
  events.push(...persisted.events);
  return persisted.result;
}

function spawnCallFields(value: unknown): {
  agent?: string;
  description?: string;
  mode?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rec = value as Record<string, unknown>;
  return {
    ...(typeof rec.agent === "string" ? { agent: rec.agent } : {}),
    ...(typeof rec.description === "string" ? { description: rec.description } : {}),
    ...(typeof rec.mode === "string" ? { mode: rec.mode } : {}),
  };
}
