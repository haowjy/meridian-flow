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
import type { BillingSpendReader } from "../../billing/index.js";
import type { AgentRevisionStore, CompiledAgentDefinition } from "../../packages/index.js";
import type { WorkContextDelivery } from "../../projects/index.js";
import type {
  BlockRepository,
  EventJournalWriter,
  SubagentThreadFactory,
  ThreadRepositories,
  ThreadRepository,
  TurnRepository,
} from "../../threads/index.js";
import { createBoundConversation } from "../../threads/index.js";
import type { ReturnResultCompleter, RunTurnPort } from "../loop/run-turn-port.js";
import type { ThreadRunOwnership } from "../loop/thread-run-ownership.js";
import type { ChildRunRegistry } from "../loop/turn-runner.js";
import { authorizeContinueTarget } from "./authorize-continue-target.js";
import type { ChildReportDelivery } from "./child-report-delivery.js";
import {
  type ChildDriveInput,
  createChildRunDriver,
  type PreparedChild,
} from "./child-run-driver.js";
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

export interface ContinueChildInput extends ChildDriveInput {
  handle: string;
  signal?: AbortSignal;
}

export type ChildRunRequest =
  | ({ kind: "spawn" } & SpawnChildInput)
  | ({ kind: "continue" } & ContinueChildInput);

export interface ChildRunOptions {
  mode: "foreground" | "background";
  /** Parent-turn card writer; foreground spawn/continue upserts running then terminal. */
  transcript?: SpawnTranscript;
}

export interface ChildRunCoordinatorDeps {
  orchestrator: RunTurnPort;
  repos: {
    threads: Pick<ThreadRepository, "updateSpawnLifecycle" | "findLiveByProjectRef">;
    subagentThreads: SubagentThreadFactory;
    turns: TurnRepository;
    blocks: BlockRepository;
    transaction: ThreadRepositories["transaction"];
  };
  resolveWorkMembership(input: {
    threadId: ThreadId;
    projectId: string;
    parentThreadId?: string | null;
  }): Promise<string>;
  eventWriter: EventJournalWriter;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readThreadBinding" | "readRevision" | "readSource" | "readPackageDefinitions" | "bindThread"
  >;
  defaultModel(): string | undefined;
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
  /** Host-availability check for a model id, used when the child has no definition. */
  modelUnavailable(model: string): string[];
  childRunRegistry: ChildRunRegistry;
  childReportDelivery: Pick<ChildReportDelivery, "enqueue">;
  workContextDelivery: Pick<WorkContextDelivery, "flushOwned">;
  runOwnership?: ThreadRunOwnership;
  billingSpendReader: BillingSpendReader;
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
  const driver = createChildRunDriver({
    orchestrator: deps.orchestrator,
    repos: {
      threads: deps.repos.threads,
      turns: deps.repos.turns,
      blocks: deps.repos.blocks,
      transaction: deps.repos.transaction,
    },
    eventWriter: deps.eventWriter,
    childRunRegistry: deps.childRunRegistry,
    childReportDelivery: deps.childReportDelivery,
    workContextDelivery: deps.workContextDelivery,
    runOwnership: deps.runOwnership,
    billingSpendReader: deps.billingSpendReader,
  });

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

  async function prepareContinue(
    input: ContinueChildInput,
    target: Thread,
    background: boolean,
  ): Promise<PreparedChild | SpawnResult> {
    const turnError = assertTurnBudget(input.budget);
    if (turnError) return { status: "error", error: turnError };

    const binding = await deps.agentRevisions.readThreadBinding(target.id);
    if (!binding) {
      return {
        status: "error",
        error: meridianErrorFromSystem(
          "continue_target_unavailable",
          "Continue target has no retained Agent binding",
        ),
      };
    }
    const resolvedSlug = binding.revision?.slug ?? GENERIC_SUBAGENT_SLUG;
    try {
      return await driver.register(target, resolvedSlug, {
        background,
        signal: input.signal,
        origin: "continue",
      });
    } catch (error) {
      return {
        status: "error",
        error: meridianErrorFromSystem(
          "continue_target_busy",
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

    const authorized = await authorizeContinueTarget({
      callerThread: request.parentThread,
      targetHandle: request.handle,
      threads: deps.repos.threads,
    });
    if (!authorized.ok) return { status: "error", error: authorized.error };
    return prepareContinue(request, authorized.target, background);
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

  async function runChild(
    request: ChildRunRequest,
    options: ChildRunOptions,
  ): Promise<SpawnResult> {
    const background = options.mode === "background";
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
    const failureCode = request.kind === "spawn" ? "spawn_failed" : "continue_failed";
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
