import { GENERIC_SUBAGENT_SLUG, type InvocationPatch } from "@meridian/contracts/agents";
import type { InvocationCardProps } from "@meridian/contracts/components";
import { meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation, SpawnResult } from "@meridian/contracts/spawn";
import type { Block, Thread, ThreadActivity } from "@meridian/contracts/threads";
import type { EventSink } from "../../observability/index.js";
import type { AgentRevisionStore, CompiledAgentDefinition } from "../../packages/index.js";
import type {
  LiveEventWriter,
  SubagentThreadFactory,
  ThreadRepositories,
  ThreadRepository,
} from "../../threads/index.js";
import { createBoundConversation, TurnStartConflictError } from "../../threads/index.js";
import type { RunClaim, WakeRefusal } from "../loop/ports.js";
import { WakeRefusedError } from "../loop/run-turn-port.js";
import type { DeliveryProducer } from "../loop/runtime-delivery.js";
import { threadReferenceBlock } from "../thread-reference.js";
import { type InvalidArgumentsResult, renderInvalidArguments } from "../tools/invalid-arguments.js";
import { appendSubagentActivity } from "./activity-event.js";
import { authorizeThreadMessage } from "./authorize-thread-message.js";
import type { ChildDriveInput, ChildRunDriver, PreparedChild } from "./child-run-driver.js";
import { type ModelFor, resolveChildInvocation } from "./resolve-child-invocation.js";
import { resolveReadableThread } from "./resolve-readable-thread.js";
import {
  invocationAgentName,
  invocationCardProps,
  unadmittedInvocationFailure,
  unadmittedInvocationFailureProps,
} from "./spawn-output.js";
import {
  bindAdmittedInvocationCard,
  persistInvocationCard,
  type SpawnTranscript,
} from "./spawn-transcript.js";
import { assertSpawnDepthAllowed, assertTurnBudget } from "./tree-budget.js";

type ChildRunResult = SpawnResult | InvalidArgumentsResult;

export interface SpawnChildInput extends ChildDriveInput {
  agentSlug?: string;
  name?: string;
  from?: string;
  appendSystemPrompt?: string;
  overrides?: InvocationPatch;
  signal?: AbortSignal;
}

export interface ThreadMessageChildInput extends ChildDriveInput {
  ref: string;
  toolCallId: string;
  signal?: AbortSignal;
}

export type ChildRunRequest =
  | ({ kind: "spawn" } & SpawnChildInput)
  | ({ kind: "message" } & ThreadMessageChildInput);

export interface ChildRunOptions {
  mode: "foreground" | "background";
  transcript?: SpawnTranscript;
}

export interface ChildRunCoordinatorDeps {
  driver: ChildRunDriver;
  repos: {
    threads: Pick<
      ThreadRepository,
      "updateSpawnLifecycle" | "findLiveByProjectRef" | "findById" | "lockByIdIncludingDeleted"
    >;
    turns: Parameters<typeof resolveReadableThread>[0]["turns"];
    subagentThreads: SubagentThreadFactory;
    transaction: ThreadRepositories["transaction"];
  };
  resolveWorkMembership(input: {
    threadId: ThreadId;
    projectId: string;
    parentThreadId?: string | null;
  }): Promise<string>;
  eventWriter: LiveEventWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  delivery: DeliveryProducer;
  wakes: Pick<RunClaim, "wakeRefusal">;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readThreadBinding" | "readRevision" | "readSource" | "readPackageDefinitions" | "bindThread"
  >;
  modelFor: ModelFor;
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
  modelUnavailable(model: string): string[];
  eventSink: EventSink;
}

export interface ChildRunCoordinator {
  runChild(request: ChildRunRequest, options: ChildRunOptions): Promise<ChildRunResult>;
}

export function createChildRunCoordinator(deps: ChildRunCoordinatorDeps): ChildRunCoordinator {
  const driver = deps.driver;

  async function prepareSpawn(
    input: SpawnChildInput,
    background: boolean,
  ): Promise<PreparedChild | ChildRunResult> {
    const depthError = assertSpawnDepthAllowed(input.budget, input.parentThread.spawnDepth);
    if (depthError) return { status: "error", error: depthError };
    const turnError = assertTurnBudget(input.budget);
    if (turnError) return { status: "error", error: turnError };

    let source: Thread | undefined;
    if (input.from !== undefined) {
      const resolved = await resolveReadableThread({
        caller: input.parentThread,
        ref: input.from,
        threads: deps.repos.threads,
        turns: deps.repos.turns,
      });
      if (!resolved.ok) return { status: "error", error: resolved.error };
      source = resolved.target;
    }
    const seedBlocks = source ? [threadReferenceBlock(source)] : undefined;

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
    if (!resolution.ok) {
      return "invalidArguments" in resolution
        ? resolution.invalidArguments
        : { status: "error", error: resolution.error };
    }
    const { revision, configuration, resolvedSlug, defaultTitle, invocationOverlay } = resolution;

    const child = await deps.repos.transaction(async () => {
      // Write parent journal rows before taking child membership's Work locks
      const lockedParent = await deps.repos.threads.lockByIdIncludingDeleted(
        input.parentThread.id as ThreadId,
      );
      const refusal = await deps.wakes.wakeRefusal({
        sender: {
          threadId: input.parentThread.id as ThreadId,
          executionId: input.parentExecutionId,
        },
        receiver: null,
      });
      if (refusal) throw new WakeRefusedError(refusal, null);
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
            aiWriteMode: (lockedParent ?? input.parentThread).aiWriteMode,
            parentThreadId: input.parentThread.id as ThreadId,
            rootThreadId: input.parentThread.rootThreadId as ThreadId,
            originTurnId: input.parentTurnId,
            spawnDepth: input.parentThread.spawnDepth + 1,
            title: input.name ?? defaultTitle,
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
        ...(source ? { fromThreadId: source.id } : {}),
      });
      if (background) {
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "background.started",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: created.id,
          agentSlug: resolvedSlug,
          name: input.name,
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
        parentThreadId: input.parentThread.id as ThreadId,
        childThreadId: child.id,
      });
      return {
        ...prepared,
        name: input.name,
        seedBlocks,
        ...(source
          ? {
              from: {
                threadId: source.id as ThreadId,
                ref: source.ref as string,
                title: source.title,
              },
            }
          : {}),
      };
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
  ): Promise<PreparedChild | ChildRunResult> {
    if (request.kind === "spawn") return prepareSpawn(request, background);

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
      correlation.origin !== (request.kind === "spawn" ? "spawn" : "message") ||
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
  ): Extract<InvocationCardProps, { terminalAt: null }> {
    if (request.kind === "spawn") {
      return invocationCardProps({
        agent: request.agentSlug,
        agentName: invocationAgentName(prepared.resolvedSlug, prepared.child.agentName),
        name: request.name,
        correlation,
        childThreadId: prepared.child.id,
        execution: null,
        startedAt: new Date().toISOString(),
        terminalAt: null,
        ...(prepared.from
          ? {
              fromThreadId: prepared.from.threadId,
              fromThreadRef: prepared.from.ref,
              fromThreadTitle: prepared.from.title,
            }
          : {}),
      });
    }
    return invocationCardProps({
      agent: prepared.resolvedSlug,
      agentName: invocationAgentName(prepared.resolvedSlug, prepared.child.agentName),
      correlation,
      childThreadId: prepared.child.id,
      execution: null,
      startedAt: new Date().toISOString(),
      terminalAt: null,
    });
  }

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
    const notifiesCaller =
      target.kind === "subagent" && target.parentThreadId === request.parentThread.id;
    try {
      await deps.delivery.enqueue({
        threadId: target.id as ThreadId,
        intent: "message",
        provenance: {
          kind: "agent",
          threadId: request.parentThread.id as ThreadId,
          sender: { ref: request.parentThread.ref, title: request.parentThread.title },
          ...(notifiesCaller
            ? { notify: { turnId: request.parentTurnId, toolCallId: request.toolCallId } }
            : {}),
        },
        body: { kind: "text", text: request.prompt },
        idempotencyKey: `thread-message:${request.toolCallId}`,
        sender: {
          threadId: request.parentThread.id as ThreadId,
          executionId: request.parentExecutionId,
        },
      });
    } catch (error) {
      if (error instanceof WakeRefusedError) return stoppedResult(error.refusal, target.ref);
      throw error;
    }
    const agentSlug =
      target.kind === "subagent"
        ? ((await deps.agentRevisions.readThreadBinding(target.id))?.revision?.slug ??
          GENERIC_SUBAGENT_SLUG)
        : target.kind;
    return {
      status: "background",
      handle: target.ref ?? "",
      threadId: target.id,
      agentSlug,
      ...(target.title ? { name: target.title } : {}),
      notifiesCaller,
    };
  }

  async function runChild(
    request: ChildRunRequest,
    options: ChildRunOptions,
  ): Promise<ChildRunResult> {
    const background = options.mode === "background";
    if (request.kind === "message" && background) {
      return sendBackgroundMessage(request);
    }

    const correlation = invocationCorrelation(request, background);

    const prepared = await prepare(request, background).catch((error: unknown) => {
      if (error instanceof WakeRefusedError) return stoppedResult(error.refusal, null);
      throw error;
    });
    if ("status" in prepared || "issues" in prepared) {
      const reason =
        "issues" in prepared
          ? renderInvalidArguments("spawn", prepared.issues)
          : prepared.status === "error"
            ? prepared.error.message
            : null;
      if (reason !== null && request.kind === "spawn") {
        await persistInvocationCard(
          options.transcript,
          unadmittedInvocationFailureProps({
            agent: request.agentSlug,
            name: request.name,
            correlation,
            reason,
          }),
        );
      }
      return prepared;
    }

    const cardProps = runCardProps(request, prepared, correlation);

    let admitted: TurnId | null = null;
    let runCard: Block | null = null;
    const onAdmitted = async (execution: TurnId, admittedAt: string) => {
      admitted = execution;
      await bindAdmittedInvocationCard({
        transcript: options.transcript,
        card: runCard,
        props: cardProps,
        execution,
        admittedAt,
      });
    };

    if (background) {
      runCard = await persistInvocationCard(options.transcript, cardProps);
      if (request.reportCorrelation && runCard) {
        request.reportCorrelation = { ...request.reportCorrelation, cardBlockId: runCard.id };
      }
      try {
        const childRun = await driver.admit(prepared, request);
        await onAdmitted(childRun.handle.executionTurnId, childRun.admittedAt);
        driver.executeBackground(childRun);
        return {
          status: "background",
          execution: childRun.handle.executionTurnId,
          handle: prepared.handle,
          threadId: prepared.child.id,
          agentSlug: prepared.resolvedSlug,
          ...(prepared.name !== undefined ? { name: prepared.name } : {}),
        };
      } catch (error) {
        if (request.kind === "spawn" && !(error instanceof WakeRefusedError)) {
          await deps.repos.threads.updateSpawnLifecycle(prepared.child.id, {
            spawnStatus: "failed",
          });
        }
        if (!admitted) {
          await persistInvocationCard(
            options.transcript,
            unadmittedInvocationFailure(cardProps, readableFailureReason(error)),
            runCard,
          );
        }
        if (error instanceof WakeRefusedError)
          return stoppedResult(error.refusal, prepared.child.ref);
        throw error;
      }
    }

    try {
      runCard = await persistInvocationCard(options.transcript, cardProps);
      if (request.reportCorrelation && runCard) {
        request.reportCorrelation = { ...request.reportCorrelation, cardBlockId: runCard.id };
      }
      const childRun = await driver.admit(prepared, request);
      await onAdmitted(childRun.handle.executionTurnId, childRun.admittedAt);
      return await driver.execute(childRun);
    } catch (error) {
      if (!admitted) {
        await persistInvocationCard(
          options.transcript,
          unadmittedInvocationFailure(cardProps, readableFailureReason(error)),
          runCard,
        );
      }
      if (error instanceof WakeRefusedError)
        return stoppedResult(error.refusal, prepared.child.ref);
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

function stoppedResult(refusal: WakeRefusal, handle: string | null): SpawnResult {
  return {
    status: "error",
    error: meridianErrorFromSystem(
      "thread_stopped",
      refusal === "sender_stopped"
        ? "This run was stopped, so nothing was sent or started."
        : `${handle ? `@${handle}` : "That thread"} was stopped, so the message wasn't sent.`,
    ),
  };
}

function readableFailureReason(error: unknown): string {
  if (error instanceof WakeRefusedError) return "Stopped before it started.";
  if (error instanceof TurnStartConflictError) {
    return error.reason === "already_running"
      ? "Still working on its last task, so this message wasn't sent."
      : "The subagent could not start.";
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The subagent could not start.";
}
