/**
 * Interrupt session for tool-driven pause/resume inside one orchestrator turn.
 *
 * Tools cannot yield from their interrupt callbacks because they run while the
 * orchestrator is awaiting tool execution. This session persists interrupt and
 * component-block events immediately for hub fan-out, buffers those same events
 * for the outer generator to yield deterministically, and mutates the supplied
 * turn state so the orchestrator resumes with the latest turn/block snapshot.
 */

import {
  type ArtifactRef,
  type AskRequest,
  componentContentForAsk,
} from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  Block,
  BlockUpsertedRow,
  JsonObject,
  OrchestratorEvent,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { contentForBlockInput, isJsonObject, localBlockFromEvent } from "./block-helpers.js";
import type {
  InterruptAutoResumePolicy,
  InterruptRegistry,
  InterruptResponse,
} from "./interrupts.js";
import { extractInterruptHints } from "./interrupts.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";

export interface InterruptArtifactFlushPort {
  flushInterruptArtifacts(input: {
    projectId: string;
    workId: string;
    provenance: {
      rootThreadId: string;
      threadId: string;
      turnId: string;
      toolCallId: string | null;
      agentSlug: string;
    };
    artifacts: ArtifactRef[];
  }): Promise<{ ok: true } | { ok: false; error: unknown }>;
}

export interface InterruptSessionDeps {
  interruptRegistry: InterruptRegistry;
  interruptArtifacts: InterruptArtifactFlushPort;
  persistenceDeps: PersistenceDeps;
  eventSink: EventSink;
}

export interface InterruptTurnState {
  thread: Thread;
  threadId: ThreadId;
  currentTurn: Turn;
  autoResume: InterruptAutoResumePolicy;
  signal?: AbortSignal;
  /**
   * Shared mutable sequence for blocks in the current assistant turn. The
   * interrupt callback increments it while the orchestrator is suspended in a
   * tool handler, so the orchestrator must read the ref after callbacks return.
   */
  blockSeqRef: { value: number };
  /**
   * In-memory block accumulator for the active run. The session updates it for
   * newly created and patched component blocks so the next context build sees
   * interrupt state without re-reading the database.
   */
  allBlocks: Block[];
}

export interface InterruptSession {
  interrupt(request: AskRequest, timeoutMs?: number): Promise<InterruptResponse>;
  updateComponentBlock(interruptId: string, propsPatch: JsonObject): Promise<void>;
  drainEvents(): OrchestratorEvent[];
}

export function createNoopInterruptArtifactFlushPort(): InterruptArtifactFlushPort {
  return {
    async flushInterruptArtifacts() {
      return { ok: true as const };
    },
  };
}

export function createInterruptSession(
  deps: InterruptSessionDeps,
  state: InterruptTurnState,
): InterruptSession {
  const interruptBlocks = new Map<string, BlockUpsertedRow>();
  const interruptEventBuffer: OrchestratorEvent[] = [];

  async function interrupt(request: AskRequest, timeoutMs?: number): Promise<InterruptResponse> {
    const effectiveTimeoutMs = timeoutMs ?? state.autoResume.timeoutMs;
    if (deps.interruptRegistry.hasPendingForTurn(state.threadId, state.currentTurn.id)) {
      throw new Error(`Interrupt already pending for turn: ${state.currentTurn.id}`);
    }
    const interruptContent = componentContentForAsk(request, effectiveTimeoutMs);
    const hints = extractInterruptHints(interruptContent, request);
    // Register before `interrupt.created` is appended: the append makes the
    // event observable, and clients may answer synchronously on that frame.
    const responsePromise = deps.interruptRegistry.waitForResponse(request.interruptId, {
      threadId: state.threadId,
      turnId: state.currentTurn.id,
      timeoutMs: effectiveTimeoutMs,
      autoResume: state.autoResume,
      recommended: hints.recommended,
      requiresHuman: hints.requiresHuman,
      signal: state.signal,
    });
    // If persistence fails, cleanup rejects the pending promise before the tool
    // awaits it; this sink prevents unhandled-rejection noise.
    void responsePromise.catch(() => {});

    let persistedInterrupt: Awaited<
      ReturnType<
        typeof persistAndAppendEvents<{
          block: Block;
          updatedTurn: Turn;
        }>
      >
    >;
    try {
      persistedInterrupt = await persistAndAppendEvents(
        deps.persistenceDeps,
        state.threadId,
        async () => {
          const block = contentForBlockInput({
            turnId: state.currentTurn.id,
            blockType: "custom",
            sequence: state.blockSeqRef.value++,
            content: interruptContent,
            status: "complete",
          });
          interruptBlocks.set(request.interruptId, block);
          const updatedTurn = {
            ...state.currentTurn,
            status: "waiting_interrupt" as const,
          };
          return {
            result: { block: localBlockFromEvent(block), updatedTurn },
            events: [
              { type: "block.upserted", block },
              {
                type: "interrupt.created",
                turnId: state.currentTurn.id,
                interruptId: request.interruptId,
                blockSequence: block.sequence,
                request,
              },
            ],
          };
        },
      );
    } catch (error) {
      deps.interruptRegistry.reject(
        request.interruptId,
        error instanceof Error ? error : new Error("Interrupt persistence failed"),
      );
      throw error;
    }
    state.allBlocks.push(persistedInterrupt.result.block);
    state.currentTurn = persistedInterrupt.result.updatedTurn;
    interruptEventBuffer.push(...persistedInterrupt.events);

    if (request.artifacts.length > 0 && state.thread.workId) {
      // DEFERRED(project workspace-reaper): no-reap-while-parked is policy; interrupt flush is the safety net.
      const flushResult = await deps.interruptArtifacts.flushInterruptArtifacts({
        projectId: state.thread.projectId,
        workId: state.thread.workId,
        provenance: {
          rootThreadId: state.thread.rootThreadId,
          threadId: state.threadId as string,
          turnId: state.currentTurn.id as string,
          toolCallId: null,
          agentSlug: state.thread.currentAgent ?? "unknown",
        },
        artifacts: request.artifacts,
      });
      if (!flushResult.ok) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.orchestrator",
          name: "interrupt_artifacts.flush_failed",
          correlation: {
            threadId: state.threadId,
            turnId: state.currentTurn.id,
            runId: state.currentTurn.id,
            projectId: state.thread.projectId,
          },
          payload: {
            threadId: state.threadId,
            turnId: state.currentTurn.id,
            projectId: state.thread.projectId,
            ...unknownToEventPayload(flushResult.error),
          },
        });
      }
    }

    // DEFERRED(durable-interrupt-resume): build when multi-replica or human
    // reply latency makes process restarts likely.
    const response = await responsePromise;

    const resumed = await persistAndAppendEvents(deps.persistenceDeps, state.threadId, async () => {
      const interruptBlock = interruptBlocks.get(request.interruptId);
      if (!interruptBlock) {
        throw new Error(`Interrupt component block not found: ${request.interruptId}`);
      }
      const updatedTurn = {
        ...state.currentTurn,
        status: "streaming" as const,
      };
      const event: OrchestratorEvent =
        response.provenance === "user"
          ? {
              type: "interrupt.resolved",
              turnId: state.currentTurn.id,
              interruptId: request.interruptId,
              blockSequence: interruptBlock.sequence,
              value: response.value,
            }
          : {
              type: "interrupt.expired",
              turnId: state.currentTurn.id,
              interruptId: request.interruptId,
              blockSequence: interruptBlock.sequence,
            };
      return { result: updatedTurn, events: [event] };
    });
    state.currentTurn = resumed.result;
    interruptEventBuffer.push(...resumed.events);
    return response;
  }

  async function updateComponentBlock(interruptId: string, propsPatch: JsonObject): Promise<void> {
    const existing = interruptBlocks.get(interruptId);
    if (!existing) {
      throw new Error(`Interrupt component block not found: ${interruptId}`);
    }
    const priorContent = existing.content;
    const priorObject = isJsonObject(priorContent) ? priorContent : {};
    const priorProps = isJsonObject(priorObject.props) ? priorObject.props : {};
    const nextContent: JsonObject = {
      ...priorObject,
      props: {
        ...priorProps,
        ...propsPatch,
      },
    };
    const persistedUpdate = await persistAndAppendEvents(
      deps.persistenceDeps,
      state.threadId,
      async () => {
        const block: BlockUpsertedRow = {
          ...existing,
          content: nextContent,
        };
        interruptBlocks.set(interruptId, block);
        return {
          result: localBlockFromEvent(block),
          events: [{ type: "block.upserted", block }],
        };
      },
    );
    const index = state.allBlocks.findIndex((block) => block.id === existing.id);
    if (index >= 0) {
      state.allBlocks[index] = persistedUpdate.result;
    } else {
      state.allBlocks.push(persistedUpdate.result);
    }
    interruptEventBuffer.push(...persistedUpdate.events);
  }

  return {
    interrupt,
    updateComponentBlock,
    drainEvents(): OrchestratorEvent[] {
      return interruptEventBuffer.splice(0);
    },
  };
}
