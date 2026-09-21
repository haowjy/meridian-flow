/**
 * ChildRunCoordinator: owns subagent thread lifecycle policy — authorize,
 * resolve the invocation, create and bind the child, and persist writer-facing
 * cards — and delegates the run lifecycle to the ChildRunDriver. The sole
 * caller allowed through the thread-create spawn gate.
 */
import { GENERIC_SUBAGENT_SLUG, type InvocationPatch } from "@meridian/contracts/agents";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import type { Block, Thread } from "@meridian/contracts/threads";
import type { AgentRevisionStore, CompiledAgentDefinition } from "../../packages/index.js";
import type {
  EventJournalWriter,
  SubagentThreadFactory,
  ThreadRepositories,
  ThreadRepository,
} from "../../threads/index.js";
import { createBoundConversation } from "../../threads/index.js";
import type { ReturnResultCompleter } from "../loop/run-turn-port.js";
import type { ThreadedInbox } from "../loop/threaded-inbox.js";
import { authorizeThreadMessage } from "./authorize-thread-message.js";
import type { ChildDriveInput, ChildRunDriver, PreparedChild } from "./child-run-driver.js";
import { resolveChildInvocation } from "./resolve-child-invocation.js";
import { persistHelperCard, type SpawnTranscript } from "./spawn-transcript.js";
import { assertSpawnDepthAllowed, assertTurnBudget } from "./tree-budget.js";

export interface SpawnChildInput extends ChildDriveInput {
  /** Named roster target; omitted or empty selects the agent-less generic subagent. */
  agentSlug?: string;
  description?: string;
  /** Per-invocation additive prompt layer; omitted appends nothing. */
  appendSystemPrompt?: string;
  /** Per-invocation execution patch, applied over the resolved baseline. */
  overrides?: InvocationPatch;
  signal?: AbortSignal;
}

export interface ThreadMessageChildInput extends ChildDriveInput {
  /** Model-facing thread handle (`pN`/`cN`). */
  ref: string;
  /** Tool-call id; scopes the background enqueue's idempotency key. */
  toolCallId: string;
  signal?: AbortSignal;
}

export type ChildRunRequest =
  | ({ kind: "spawn" } & SpawnChildInput)
  | ({ kind: "message" } & ThreadMessageChildInput);

export interface ChildRunOptions {
  mode: "foreground" | "background";
  /** Parent-turn card writer; foreground spawn/continue upserts running then terminal. */
  transcript?: SpawnTranscript;
}

export interface ChildRunCoordinatorDeps {
  /** Run lifecycle: claim, registry, stream, capture, terminal persistence. */
  driver: ChildRunDriver;
  repos: {
    threads: Pick<ThreadRepository, "updateSpawnLifecycle" | "findLiveByProjectRef" | "findById">;
    subagentThreads: SubagentThreadFactory;
    transaction: ThreadRepositories["transaction"];
  };
  resolveWorkMembership(input: {
    threadId: ThreadId;
    projectId: string;
    parentThreadId?: string | null;
  }): Promise<string>;
  eventWriter: EventJournalWriter;
  /** Producer-facing inbox: background thread_message enqueues here. */
  threadedInbox: Pick<ThreadedInbox, "enqueue">;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readThreadBinding" | "readRevision" | "readSource" | "readPackageDefinitions" | "bindThread"
  >;
  defaultModel(): string | undefined;
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
  /** Host-availability check for a model id, used when the child has no definition. */
  modelUnavailable(model: string): string[];
}

export interface ChildRunCoordinator {
  runChild(request: ChildRunRequest, options: ChildRunOptions): Promise<SpawnResult>;
  /**
   * One-shot return_result acknowledgement for a settle-only run (a writer
   * driving a child chat): it records nothing and never captures a report.
   */
  createReturnResultCompleter(): ReturnResultCompleter;
}

export function createChildRunCoordinator(deps: ChildRunCoordinatorDeps): ChildRunCoordinator {
  const driver = deps.driver;

  function createReturnResultCompleter(): ReturnResultCompleter {
    let used = false;
    return async () => {
      if (used) {
        return { ok: false as const, message: "return_result already called for this run" };
      }
      used = true;
      return { ok: true as const };
    };
  }

  async function prepareSpawn(
    input: SpawnChildInput,
    background: boolean,
  ): Promise<PreparedChild | SpawnResult> {
    const depthError = assertSpawnDepthAllowed(input.budget, input.parentThread.spawnDepth);
    if (depthError) return { status: "error", error: depthError };
    const turnError = assertTurnBudget(input.budget);
    if (turnError) return { status: "error", error: turnError };

    const parentAgent = await deps.agentRevisions.readThreadBinding(input.parentThread.id);
    if (!parentAgent) {
      return {
        status: "error",
        error: meridianErrorFromSystem("spawn_failed", "Caller has no retained Agent binding"),
      };
    }

    const resolution = await resolveChildInvocation(
      {
        parentAgent,
        requestedSlug: input.agentSlug?.trim() ?? "",
        ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
        ...(input.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: input.appendSystemPrompt }
          : {}),
      },
      deps,
    );
    if (!resolution.ok) return { status: "error", error: resolution.error };
    const { revision, configuration, resolvedSlug, defaultTitle, invocationOverlay } = resolution;

    const child = await deps.repos.transaction(async () => {
      const created = await createBoundConversation({
        transaction: deps.repos.transaction,
        agentRevisions: deps.agentRevisions,
        revision,
        configuration,
        invocationOverlay,
        createThread: () =>
          deps.repos.subagentThreads.createSubagent({
            id: crypto.randomUUID() as ThreadId,
            userId: input.parentThread.userId,
            projectId: input.parentThread.projectId,
            parentThreadId: input.parentThread.id as ThreadId,
            rootThreadId: input.parentThread.rootThreadId as ThreadId,
            originTurnId: input.parentTurnId,
            spawnDepth: input.parentThread.spawnDepth + 1,
            title: input.description ?? defaultTitle,
            spawnStatus: "running",
          }),
        resolveWork: (created) =>
          deps.resolveWorkMembership({
            threadId: created.id as ThreadId,
            projectId: input.parentThread.projectId,
            parentThreadId: input.parentThread.id as ThreadId,
          }),
      });

      await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
        type: "agent.spawn",
        parentThreadId: input.parentThread.id,
        parentTurnId: input.parentTurnId as string,
        childThreadId: created.id,
        agentSlug: resolvedSlug,
        prompt: input.prompt,
      });
      if (background) {
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "background.started",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: created.id,
          agentSlug: resolvedSlug,
          description: input.description,
        });
      }
      return created;
    });

    try {
      const prepared = await driver.register(child, resolvedSlug, {
        background,
        signal: input.signal,
        origin: "spawn",
      });
      return { ...prepared, description: input.description };
    } catch (error) {
      const result: SpawnResult = {
        status: "error",
        error: meridianErrorFromSystem(
          "spawn_failed",
          error instanceof Error ? error.message : String(error),
        ),
      };
      await deps.repos.transaction(async () => {
        await deps.repos.threads.updateSpawnLifecycle(child.id as ThreadId, {
          spawnStatus: "failed",
          spawnResult: result,
        });
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "agent.run_completed",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: child.id,
          result,
        });
      });
      throw error;
    }
  }

  async function prepareForegroundMessage(
    input: ThreadMessageChildInput,
    target: Thread,
  ): Promise<PreparedChild | SpawnResult> {
    const turnError = assertTurnBudget(input.budget);
    if (turnError) return { status: "error", error: turnError };

    const binding = await deps.agentRevisions.readThreadBinding(target.id);
    if (!binding) {
      return {
        status: "error",
        error: meridianErrorFromSystem(
          "thread_message_target_unavailable",
          "Thread has no retained Agent binding",
        ),
      };
    }
    const resolvedSlug = binding.revision?.slug ?? GENERIC_SUBAGENT_SLUG;
    try {
      return await driver.register(target, resolvedSlug, {
        background: false,
        signal: input.signal,
        origin: "message",
      });
    } catch (error) {
      return {
        status: "error",
        error: meridianErrorFromSystem(
          "thread_message_target_busy",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }

  async function prepare(
    request: ChildRunRequest,
    background: boolean,
    transcript: SpawnTranscript | undefined,
  ): Promise<PreparedChild | SpawnResult> {
    if (request.kind === "spawn") {
      const outcome = await prepareSpawn(request, background);
      // A failed spawn shows its error on the parent card; a background spawn
      // has no parent-turn card writer, so it only returns the error.
      if ("status" in outcome && !background) {
        await persistHelperCard(transcript, {
          agent: request.agentSlug,
          description: request.description,
          parentTurnId: request.parentTurnId as string,
          output: outcome,
        });
      }
      return outcome;
    }

    const authorized = await authorizeThreadMessage({
      callerThread: request.parentThread,
      targetRef: request.ref,
      mode: background ? "background" : "foreground",
      threads: deps.repos.threads,
    });
    if (!authorized.ok) return { status: "error", error: authorized.error };
    return prepareForegroundMessage(request, authorized.target);
  }

  async function persistRunningCard(
    transcript: SpawnTranscript | undefined,
    fields: Parameters<typeof persistHelperCard>[1],
    prepared: PreparedChild,
  ): Promise<Block | null> {
    try {
      return await persistHelperCard(transcript, fields);
    } catch (error) {
      await driver.release(prepared);
      throw error;
    }
  }

  function foregroundCardFields(
    request: ChildRunRequest,
    prepared: PreparedChild,
  ): Parameters<typeof persistHelperCard>[1] {
    if (request.kind === "spawn") {
      return {
        agent: request.agentSlug,
        description: request.description,
        parentTurnId: request.parentTurnId as string,
        childThreadId: prepared.child.id,
      };
    }
    return {
      agent: prepared.resolvedSlug,
      parentTurnId: request.parentTurnId as string,
      childThreadId: prepared.child.id,
    };
  }

  /**
   * Background thread_message is a queue producer only: authorize, enqueue a
   * durable steer, return. The target's own run (woken by the inbox) drains it;
   * nothing is driven in the caller's process.
   */
  async function sendBackgroundMessage(
    request: {
      kind: "message";
    } & ThreadMessageChildInput,
  ): Promise<SpawnResult> {
    const authorized = await authorizeThreadMessage({
      callerThread: request.parentThread,
      targetRef: request.ref,
      mode: "background",
      threads: deps.repos.threads,
    });
    if (!authorized.ok) return { status: "error", error: authorized.error };

    const target = authorized.target;
    await deps.threadedInbox.enqueue({
      threadId: target.id as ThreadId,
      intent: "steer",
      provenance: { kind: "agent", threadId: request.parentThread.id as ThreadId },
      body: { kind: "text", text: request.prompt },
      idempotencyKey: `thread-message:${request.toolCallId}`,
    });
    return {
      status: "background",
      handle: target.ref ?? "",
      threadId: target.id,
      agentSlug: target.kind === "subagent" ? GENERIC_SUBAGENT_SLUG : target.kind,
    };
  }

  async function runChild(
    request: ChildRunRequest,
    options: ChildRunOptions,
  ): Promise<SpawnResult> {
    const background = options.mode === "background";
    if (request.kind === "message" && background) {
      return sendBackgroundMessage(request);
    }

    const prepared = await prepare(request, background, options.transcript);
    if ("status" in prepared) return prepared;

    if (background) {
      driver.driveBackground(prepared, request);
      return {
        status: "background",
        handle: prepared.handle,
        threadId: prepared.child.id,
        agentSlug: prepared.resolvedSlug,
        ...(prepared.description !== undefined ? { description: prepared.description } : {}),
      };
    }

    const cardFields = foregroundCardFields(request, prepared);
    const failureCode = request.kind === "spawn" ? "spawn_failed" : "thread_message_failed";
    let runningCard: Block | null = null;
    try {
      runningCard = await persistRunningCard(options.transcript, cardFields, prepared);
      const result = await driver.drive(prepared, request);
      await persistHelperCard(options.transcript, { ...cardFields, output: result }, runningCard);
      return result;
    } catch (error) {
      await persistHelperCard(
        options.transcript,
        {
          ...cardFields,
          output: {
            status: "error",
            error: meridianErrorFromSystem(
              failureCode,
              error instanceof Error ? error.message : String(error),
            ),
          },
        },
        runningCard,
      );
      throw error;
    }
  }

  return { runChild, createReturnResultCompleter };
}
