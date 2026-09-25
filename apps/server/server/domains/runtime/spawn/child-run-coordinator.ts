/**
 * ChildRunCoordinator: owns subagent thread lifecycle policy — authorize,
 * resolve the invocation, create and bind the child, and persist writer-facing
 * cards — and delegates the run lifecycle to the ChildRunDriver. The sole
 * caller allowed through the thread-create spawn gate.
 */
import { GENERIC_SUBAGENT_SLUG, type InvocationPatch } from "@meridian/contracts/agents";
import type { InvocationCardProps } from "@meridian/contracts/components";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation, SpawnResult } from "@meridian/contracts/spawn";
import type { Block, Thread, ThreadActivity } from "@meridian/contracts/threads";
import type { EventSink } from "../../observability/index.js";
import type { AgentRevisionStore, CompiledAgentDefinition } from "../../packages/index.js";
import type {
  EventJournalWriter,
  SubagentThreadFactory,
  ThreadRepositories,
  ThreadRepository,
} from "../../threads/index.js";
import { createBoundConversation, TurnStartConflictError } from "../../threads/index.js";
import type { DeliveryProducer } from "../loop/runtime-delivery.js";
import { appendSubagentActivity } from "./activity-event.js";
import { authorizeThreadMessage } from "./authorize-thread-message.js";
import type { ChildDriveInput, ChildRunDriver, PreparedChild } from "./child-run-driver.js";
import { resolveChildInvocation } from "./resolve-child-invocation.js";
import { invocationCardProps, unadmittedInvocationFailure } from "./spawn-output.js";
import {
  bindAdmittedInvocationCard,
  persistHelperCard,
  persistInvocationCard,
  type SpawnTranscript,
} from "./spawn-transcript.js";
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
  /**
   * Parent-turn card writer. A foreground spawn/continue upserts the running
   * card; report publication replaces that same card after terminal commit.
   */
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
  /** Recomputes a run tree's activity; feeds the root-journal `subagent.activity` fact. */
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  /** Producer-facing inbox: background thread_message enqueues here. */
  delivery: DeliveryProducer;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readThreadBinding" | "readRevision" | "readSource" | "readPackageDefinitions" | "bindThread"
  >;
  defaultModel(): string | undefined;
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
  /** Host-availability check for a model id, used when the child has no definition. */
  modelUnavailable(model: string): string[];
  eventSink: EventSink;
}

export interface ChildRunCoordinator {
  runChild(request: ChildRunRequest, options: ChildRunOptions): Promise<SpawnResult>;
}

export function createChildRunCoordinator(deps: ChildRunCoordinatorDeps): ChildRunCoordinator {
  const driver = deps.driver;

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
      await appendSubagentActivity({
        eventWriter: deps.eventWriter,
        readActivity: deps.readActivity,
        rootThreadId: input.parentThread.rootThreadId as ThreadId,
        childThreadId: child.id,
      });
      return { ...prepared, description: input.description };
    } catch (error) {
      await deps.repos.threads.updateSpawnLifecycle(child.id as ThreadId, {
        spawnStatus: "failed",
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
    return driver.register(target, binding.revision?.slug ?? GENERIC_SUBAGENT_SLUG, {
      background: false,
      signal: input.signal,
      origin: "message",
    });
  }

  async function prepare(
    request: ChildRunRequest,
    background: boolean,
    transcript: SpawnTranscript | undefined,
  ): Promise<PreparedChild | SpawnResult> {
    if (request.kind === "spawn") {
      const outcome = await prepareSpawn(request, background);
      // A failed spawn shows its error on the parent-turn run card; foreground
      // and background both have a card writer now.
      if ("status" in outcome) {
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

  function invocationCorrelation(
    request: ChildRunRequest,
    background: boolean,
  ): Pick<InvocationCardProps, "parentTurnId" | "toolCallId" | "deliveryMode"> {
    const correlation: ExecutionReportCorrelation | undefined = request.reportCorrelation;
    if (
      !correlation?.callerTurnId ||
      !correlation.toolCallId ||
      correlation.callerThreadId !== request.parentThread.id ||
      correlation.callerTurnId !== request.parentTurnId ||
      correlation.cardBlockId !== null ||
      correlation.origin !== (request.kind === "spawn" ? "spawn" : "foreground_message") ||
      (request.kind === "message" && correlation.toolCallId !== request.toolCallId) ||
      correlation.deliveryMode !== (background ? "background_notification" : "direct")
    ) {
      throw new Error("Child invocation has invalid parent report correlation");
    }
    return {
      parentTurnId: correlation.callerTurnId,
      toolCallId: correlation.toolCallId,
      deliveryMode: correlation.deliveryMode,
    };
  }

  function runCardProps(
    request: ChildRunRequest,
    prepared: PreparedChild,
    correlation: Pick<InvocationCardProps, "parentTurnId" | "toolCallId" | "deliveryMode">,
  ): InvocationCardProps {
    if (request.kind === "spawn") {
      return invocationCardProps({
        agent: request.agentSlug,
        description: request.description,
        correlation,
        childThreadId: prepared.child.id,
        execution: null,
      });
    }
    return invocationCardProps({
      agent: prepared.resolvedSlug,
      correlation,
      childThreadId: prepared.child.id,
      execution: null,
    });
  }

  /**
   * Background thread_message is a queue producer only: authorize, enqueue a
   * durable message, return. The target's own run (woken by the inbox) drains it;
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
    await deps.delivery.enqueue({
      threadId: target.id as ThreadId,
      intent: "message",
      provenance: { kind: "agent", threadId: request.parentThread.id as ThreadId },
      body: { kind: "text", text: request.prompt },
      idempotencyKey: `thread-message:${request.toolCallId}`,
    });
    // The target drives its own run in its own process, so no lease is held here
    // and no activity frame fires from this call. The woken process emits the
    // start and terminal frames when it acquires and releases its lease, so the
    // strip shows the target `awake` for the whole run.
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

    const correlation = invocationCorrelation(request, background);

    const prepared = await prepare(request, background, options.transcript);
    if ("status" in prepared) return prepared;

    const cardProps = runCardProps(request, prepared, correlation);

    let admitted: TurnId | null = null;
    let runCard: Block | null = null;
    const onAdmitted = async (execution: TurnId) => {
      admitted = execution;
      await bindAdmittedInvocationCard({
        transcript: options.transcript,
        delivery: deps.delivery,
        card: runCard,
        props: cardProps,
        execution,
      });
    };

    if (background) {
      // The original card survives parent continuation and B replaces only its status.
      runCard = await persistInvocationCard(options.transcript, cardProps);
      if (request.reportCorrelation && runCard) {
        request.reportCorrelation = { ...request.reportCorrelation, cardBlockId: runCard.id };
      }
      try {
        const execution = await driver.driveBackground(prepared, request, onAdmitted);
        return {
          status: "background",
          execution,
          handle: prepared.handle,
          threadId: prepared.child.id,
          agentSlug: prepared.resolvedSlug,
          ...(prepared.description !== undefined ? { description: prepared.description } : {}),
        };
      } catch (error) {
        if (request.kind === "spawn") {
          await deps.repos.threads.updateSpawnLifecycle(prepared.child.id, {
            spawnStatus: "failed",
          });
        }
        if (!admitted) {
          await persistInvocationCard(
            options.transcript,
            unadmittedInvocationFailure(cardProps),
            runCard,
          );
        }
        throw error;
      }
    }

    try {
      runCard = await persistInvocationCard(options.transcript, cardProps);
      if (request.reportCorrelation && runCard) {
        request.reportCorrelation = { ...request.reportCorrelation, cardBlockId: runCard.id };
      }
      return await driver.drive(prepared, request, onAdmitted);
    } catch (error) {
      if (!admitted) {
        await persistInvocationCard(
          options.transcript,
          unadmittedInvocationFailure(cardProps),
          runCard,
        );
      }
      if (request.kind === "message" && error instanceof TurnStartConflictError) {
        return {
          status: "error",
          error: meridianErrorFromSystem(
            "thread_message_target_busy",
            "Child thread already has an active run",
          ),
        };
      }
      throw error;
    }
  }

  return { runChild };
}
