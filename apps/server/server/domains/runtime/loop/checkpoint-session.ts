/**
 * Checkpoint session for tool-driven pause/resume inside one orchestrator turn.
 *
 * Tools cannot yield from their checkpoint callbacks because they run while the
 * orchestrator is awaiting tool execution. This session persists checkpoint and
 * component-block events immediately for hub fan-out, buffers those same events
 * for the outer generator to yield deterministically, and mutates the supplied
 * turn state so the orchestrator resumes with the latest turn/block snapshot.
 */

import {
  type ArtifactRef,
  type CheckpointRequest,
  componentContentForCheckpoint,
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
  CheckpointAutoResumePolicy,
  CheckpointRegistry,
  CheckpointResponse,
} from "./checkpoints.js";
import { extractCheckpointHints } from "./checkpoints.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";

export interface CheckpointArtifactFlushPort {
  flushCheckpointArtifacts(input: {
    projectId: string;
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

export interface CheckpointSessionDeps {
  checkpointRegistry: CheckpointRegistry;
  checkpointArtifacts: CheckpointArtifactFlushPort;
  persistenceDeps: PersistenceDeps;
  eventSink: EventSink;
}

export interface CheckpointTurnState {
  thread: Thread;
  threadId: ThreadId;
  currentTurn: Turn;
  autoResume: CheckpointAutoResumePolicy;
  signal?: AbortSignal;
  /**
   * Shared mutable sequence for blocks in the current assistant turn. The
   * checkpoint callback increments it while the orchestrator is suspended in a
   * tool handler, so the orchestrator must read the ref after callbacks return.
   */
  blockSeqRef: { value: number };
  /**
   * In-memory block accumulator for the active run. The session updates it for
   * newly created and patched component blocks so the next context build sees
   * checkpoint state without re-reading the database.
   */
  allBlocks: Block[];
}

export interface CheckpointSession {
  checkpoint(request: CheckpointRequest, timeoutMs?: number): Promise<CheckpointResponse>;
  updateComponentBlock(checkpointId: string, propsPatch: JsonObject): Promise<void>;
  drainEvents(): OrchestratorEvent[];
}

export function createNoopCheckpointArtifactFlushPort(): CheckpointArtifactFlushPort {
  return {
    async flushCheckpointArtifacts() {
      return { ok: true as const };
    },
  };
}

export function createCheckpointSession(
  deps: CheckpointSessionDeps,
  state: CheckpointTurnState,
): CheckpointSession {
  const checkpointBlocks = new Map<string, BlockUpsertedRow>();
  const checkpointEventBuffer: OrchestratorEvent[] = [];

  async function checkpoint(
    request: CheckpointRequest,
    timeoutMs?: number,
  ): Promise<CheckpointResponse> {
    const effectiveTimeoutMs = timeoutMs ?? state.autoResume.timeoutMs;
    if (deps.checkpointRegistry.hasPendingForTurn(state.threadId, state.currentTurn.id)) {
      throw new Error(`Checkpoint already pending for turn: ${state.currentTurn.id}`);
    }
    const checkpointContent = componentContentForCheckpoint(request, effectiveTimeoutMs);
    const hints = extractCheckpointHints(checkpointContent, request);
    // Register before `checkpoint.created` is appended: the append makes the
    // event observable, and clients may answer synchronously on that frame.
    const responsePromise = deps.checkpointRegistry.waitForResponse(request.checkpointId, {
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

    let persistedCheckpoint: Awaited<
      ReturnType<
        typeof persistAndAppendEvents<{
          block: Block;
          updatedTurn: Turn;
        }>
      >
    >;
    try {
      persistedCheckpoint = await persistAndAppendEvents(
        deps.persistenceDeps,
        state.threadId,
        async () => {
          const block = contentForBlockInput({
            turnId: state.currentTurn.id,
            blockType: "custom",
            sequence: state.blockSeqRef.value++,
            content: checkpointContent,
            status: "complete",
          });
          checkpointBlocks.set(request.checkpointId, block);
          const updatedTurn = {
            ...state.currentTurn,
            status: "waiting_checkpoint" as const,
          };
          return {
            result: { block: localBlockFromEvent(block), updatedTurn },
            events: [
              { type: "block.upserted", block },
              {
                type: "checkpoint.created",
                turnId: state.currentTurn.id,
                checkpointId: request.checkpointId,
                blockSequence: block.sequence,
                request,
              },
            ],
          };
        },
      );
    } catch (error) {
      deps.checkpointRegistry.reject(
        request.checkpointId,
        error instanceof Error ? error : new Error("Checkpoint persistence failed"),
      );
      throw error;
    }
    state.allBlocks.push(persistedCheckpoint.result.block);
    state.currentTurn = persistedCheckpoint.result.updatedTurn;
    checkpointEventBuffer.push(...persistedCheckpoint.events);

    if (request.artifacts.length > 0) {
      // DEFERRED(project workspace-reaper): no-reap-while-parked is policy; checkpoint flush is the safety net.
      const flushResult = await deps.checkpointArtifacts.flushCheckpointArtifacts({
        projectId: state.thread.projectId,
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
          name: "checkpoint_artifacts.flush_failed",
          payload: {
            threadId: state.threadId,
            turnId: state.currentTurn.id,
            projectId: state.thread.projectId,
            ...unknownToEventPayload(flushResult.error),
          },
        });
      }
    }

    // DEFERRED(durable-checkpoint-resume): build when multi-replica or human
    // reply latency makes process restarts likely.
    const response = await responsePromise;

    const resumed = await persistAndAppendEvents(deps.persistenceDeps, state.threadId, async () => {
      const checkpointBlock = checkpointBlocks.get(request.checkpointId);
      if (!checkpointBlock) {
        throw new Error(`Checkpoint component block not found: ${request.checkpointId}`);
      }
      const updatedTurn = {
        ...state.currentTurn,
        status: "streaming" as const,
      };
      const event: OrchestratorEvent =
        response.provenance === "user"
          ? {
              type: "checkpoint.resolved",
              turnId: state.currentTurn.id,
              checkpointId: request.checkpointId,
              blockSequence: checkpointBlock.sequence,
              value: response.value,
            }
          : {
              type: "checkpoint.expired",
              turnId: state.currentTurn.id,
              checkpointId: request.checkpointId,
              blockSequence: checkpointBlock.sequence,
            };
      return { result: updatedTurn, events: [event] };
    });
    state.currentTurn = resumed.result;
    checkpointEventBuffer.push(...resumed.events);
    return response;
  }

  async function updateComponentBlock(checkpointId: string, propsPatch: JsonObject): Promise<void> {
    const existing = checkpointBlocks.get(checkpointId);
    if (!existing) {
      throw new Error(`Checkpoint component block not found: ${checkpointId}`);
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
        checkpointBlocks.set(checkpointId, block);
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
    checkpointEventBuffer.push(...persistedUpdate.events);
  }

  return {
    checkpoint,
    updateComponentBlock,
    drainEvents(): OrchestratorEvent[] {
      return checkpointEventBuffer.splice(0);
    },
  };
}
