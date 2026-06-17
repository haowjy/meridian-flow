/**
 * Stateless tool dispatch step for the runtime loop.
 *
 * The orchestrator decides whether a tool call is allowed; this module owns the
 * mechanics of running the allowed call: live output journal appends, spawn and
 * return-result bridges, checkpoint callback wiring, and durable tool_result
 * persistence. The caller supplies mutable turn/block state so checkpoint
 * callbacks can update the active turn while the tool handler is awaited.
 */

import type { TreeBudget } from "@meridian/contracts/spawn";
import type { Block, OrchestratorEvent, Thread } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import type { ToolCallInput, ToolExecutor } from "../tools/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import type { CheckpointSession, CheckpointTurnState } from "./checkpoint-session.js";
import type { CheckpointAutoResumePolicy } from "./checkpoints.js";
import { appendEvent, type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";
import type { ReturnResultCompleter } from "./run-turn-port.js";

export interface ToolDispatchDeps {
  toolExecutor: ToolExecutor;
  childRunCoordinator: ChildRunCoordinator;
  eventSink: EventSink;
  persistenceDeps: PersistenceDeps;
}

export interface ToolDispatchContext {
  thread: Thread;
  state: CheckpointTurnState;
  checkpointSession: CheckpointSession;
  checkpointAutoResume: CheckpointAutoResumePolicy;
  treeBudget: TreeBudget;
  blockSeqRef: { value: number };
  returnResultCompleter?: ReturnResultCompleter;
}

export type ToolDispatchResult =
  | { events: OrchestratorEvent[]; block: Block; cancelled?: false }
  | { events: OrchestratorEvent[]; cancelled: true };

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
          agent: string;
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

  const execResult = await deps.toolExecutor.executeTool(
    { id: call.id, name: call.name, arguments: call.arguments },
    {
      threadId: ctx.state.threadId,
      turnId: ctx.state.currentTurn.id,
      agentSlug: ctx.thread.currentAgent,
      signal: ctx.state.signal,
      checkpointTimeoutMs: ctx.checkpointAutoResume.timeoutMs,
      emitOutputDelta,
      checkpoint: ctx.checkpointSession.checkpoint,
      updateComponentBlock: ctx.checkpointSession.updateComponentBlock,
      spawn,
      returnResult,
    },
  );
  await outputDeltaAppendChain;
  events.push(...outputDeltaEventBuffer, ...ctx.checkpointSession.drainEvents());
  if (ctx.state.signal?.aborted) {
    return { events, cancelled: true };
  }

  const persistedToolResult = await persistAndAppendEvents(
    deps.persistenceDeps,
    ctx.state.threadId,
    async () => {
      const block = contentForBlockInput({
        turnId: ctx.state.currentTurn.id,
        blockType: "tool_result",
        sequence: ctx.blockSeqRef.value++,
        content: {
          toolCallId: execResult.toolCallId,
          output: execResult.output,
          ...(execResult.isError !== undefined ? { isError: execResult.isError } : {}),
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
            output: execResult.output,
            isError: execResult.isError,
          },
        ],
      };
    },
  );
  ctx.state.allBlocks.push(persistedToolResult.result);
  events.push(...persistedToolResult.events);
  return { events, block: persistedToolResult.result };
}
