/**
 * ChildRunCoordinator: owns subagent thread lifecycle, drives child runTurn to
 * terminal state, captures return_result, and persists spawnStatus/spawnResult.
 * The sole caller allowed through the thread-create spawn gate.
 */
import {
  GENERIC_SUBAGENT_SLUG,
  type InvocationOverlay,
  type InvocationPatch,
  type ResolvedAgentConfiguration,
} from "@meridian/contracts/agents";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AgentReport,
  ReturnResultCapture,
  SpawnResult,
  TreeBudget,
} from "@meridian/contracts/spawn";
import { type Block, blockPlainText, type Thread } from "@meridian/contracts/threads";
import type { BillingSpendReader } from "../../billing/index.js";
import {
  type AgentRevision,
  type AgentRevisionStore,
  type CompiledAgentDefinition,
  resolveAgentConfiguration,
} from "../../packages/index.js";
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
import { validateInvocationAuthority } from "../loop/permissions/invocation-authority.js";
import type { ReturnResultCompleter, RunTurnPort } from "../loop/run-turn-port.js";
import {
  createInMemoryThreadRunOwnership,
  type ThreadRunClaim,
  type ThreadRunOwnership,
} from "../loop/thread-run-ownership.js";
import type { ChildRunRegistry } from "../loop/turn-runner.js";
import { applyInvocationPatch, InvocationPatchError } from "./apply-invocation-patch.js";
import { authorizeContinueTarget, type ContinueTarget } from "./authorize-continue-target.js";
import type { ChildReportDelivery } from "./child-report-delivery.js";
import { persistHelperCard, type SpawnTranscript } from "./spawn-transcript.js";
import { assertSpawnDepthAllowed, assertTurnBudget } from "./tree-budget.js";

export interface ChildDriveInput {
  parentThread: Thread;
  parentTurnId: TurnId;
  prompt: string;
  budget: TreeBudget;
  signal?: AbortSignal;
}

export interface SpawnChildInput extends ChildDriveInput {
  /** Named roster target; omitted or empty selects the agent-less generic subagent. */
  agentSlug?: string;
  description?: string;
  /** Per-invocation additive prompt layer; omitted appends nothing. */
  appendSystemPrompt?: string;
  /** Per-invocation execution patch, applied over the resolved baseline. */
  overrides?: InvocationPatch;
  /** Parent-turn card writer; foreground spawn upserts running then completed. */
  transcript?: SpawnTranscript;
}

export interface ContinueChildInput extends ChildDriveInput {
  childThreadId: ThreadId;
  /** Parent-turn card writer; foreground continue upserts running then completed. */
  transcript?: SpawnTranscript;
}

export interface ChildRunCoordinatorDeps {
  orchestrator: RunTurnPort;
  repos: {
    threads: Pick<ThreadRepository, "updateSpawnLifecycle" | "findById">;
    subagentThreads: SubagentThreadFactory;
    turns: TurnRepository;
    blocks: BlockRepository;
    transaction: ThreadRepositories["transaction"];
    threadWorks: ThreadRepositories["threadWorks"];
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
  spawnChild(input: SpawnChildInput): Promise<SpawnResult>;
  spawnChildBackground(input: SpawnChildInput): Promise<SpawnResult>;
  continueChild(input: ContinueChildInput): Promise<SpawnResult>;
  continueChildBackground(input: ContinueChildInput): Promise<SpawnResult>;
  createReturnResultCompleter(
    childThreadId: ThreadId,
    options?: {
      capture?: boolean;
      /** Durable side-effect for a captured report; runs before the turn settles. */
      onCapture?: (capture: ReturnResultCapture) => Promise<void>;
    },
  ): ReturnResultCompleter;
}

type ChildTerminal =
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; message: string; code: string };

type PreparedChild = {
  child: Thread;
  /** Event/thread-visible slug; a named roster name or the generic subagent label. */
  resolvedSlug: string;
  /** Delivery-card title for a background spawn; omitted for continue. */
  description?: string;
  childController: AbortController;
  childRegistered: boolean;
  runClaim: ThreadRunClaim;
  background: boolean;
  /** Spawn creates the child lifecycle; continue never rewrites it. */
  origin: "spawn" | "continue";
};

async function synthesizeIncompleteReport(
  repos: ChildRunCoordinatorDeps["repos"],
  childThreadId: ThreadId,
  costMillicredits: number,
): Promise<AgentReport> {
  const turns = await repos.turns.listByThread(childThreadId);
  let summary = "Child run ended without return_result";
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role !== "assistant") continue;
    const blocks = await repos.blocks.listByTurn(turn.id);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block?.blockType !== "text") continue;
      const text = blockPlainText(block.blockType, block.content)?.trim();
      if (text) {
        summary = text;
        break;
      }
    }
    break;
  }
  return {
    threadId: childThreadId as string,
    summary,
    costMillicredits,
    incomplete: true,
  };
}

export function createChildRunCoordinator(deps: ChildRunCoordinatorDeps): ChildRunCoordinator {
  const runOwnership = deps.runOwnership ?? createInMemoryThreadRunOwnership();
  const pendingReports = new Map<string, AgentReport>();

  function createReturnResultCompleter(
    childThreadId: ThreadId,
    options?: {
      capture?: boolean;
      onCapture?: (capture: ReturnResultCapture) => Promise<void>;
    },
  ): ReturnResultCompleter {
    let used = false;
    const captureReport = options?.capture !== false;
    const onCapture = options?.onCapture;
    return async (capture: ReturnResultCapture) => {
      if (used) {
        return { ok: false as const, message: "return_result already called for this run" };
      }
      used = true;
      if (captureReport) {
        pendingReports.set(childThreadId as string, {
          threadId: childThreadId as string,
          summary: capture.summary,
          payload: capture.payload,
          artifacts: capture.artifacts,
          costMillicredits: 0,
        });
        // Runs at the moment the report is produced, before the child turn
        // settles and before driveChild can continue.
        if (onCapture) await onCapture(capture);
      }
      return { ok: true as const };
    };
  }

  async function prepareChild(
    input: SpawnChildInput,
    options: { background?: boolean } = {},
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

    const requestedSlug = input.agentSlug?.trim() ?? "";
    let revision: AgentRevision | null;
    let configuration: ResolvedAgentConfiguration;
    let resolvedSlug: string;
    let defaultTitle: string;
    let patchPackageRoot: string | null;
    if (requestedSlug === "") {
      configuration = { ...parentAgent.configuration };
      revision = null;
      resolvedSlug = GENERIC_SUBAGENT_SLUG;
      defaultTitle = GENERIC_SUBAGENT_SLUG;
      patchPackageRoot = parentAgent.revision?.packageRevisionId ?? null;
    } else {
      const target = parentAgent.configuration.namedTargets.find(
        (item) => item.name === requestedSlug,
      );
      if (!target) {
        return {
          status: "error",
          error: meridianErrorFromSystem(
            "spawn_agent_not_allowed",
            `Agent "${requestedSlug}" is not in caller subagents`,
          ),
        };
      }
      const childAgent = await deps.agentRevisions.readRevision(target.definitionRevisionId);
      if (!childAgent || childAgent.definition.metadata["model-invocable"] === false) {
        return {
          status: "error",
          error: meridianErrorFromSystem(
            "spawn_agent_not_found",
            `Agent "${requestedSlug}" is unavailable in the caller's retained package`,
          ),
        };
      }
      revision = childAgent;
      configuration = await resolveAgentConfiguration({
        revision: childAgent,
        store: deps.agentRevisions,
        defaultModel: deps.defaultModel(),
      });
      resolvedSlug = requestedSlug;
      defaultTitle = `${requestedSlug} subagent`;
      patchPackageRoot = childAgent.packageRevisionId;
    }

    if (input.overrides !== undefined) {
      let patched: ResolvedAgentConfiguration;
      try {
        patched = await applyInvocationPatch({
          baseline: configuration,
          patch: input.overrides,
          caller: parentAgent.configuration,
          store: deps.agentRevisions,
          packageRevisionId: patchPackageRoot,
        });
      } catch (error) {
        if (error instanceof InvocationPatchError) {
          return {
            status: "error",
            error: meridianErrorFromSystem("spawn_invocation_patch_invalid", error.message),
          };
        }
        throw error;
      }
      const reasons = validateInvocationAuthority({
        baseline: configuration,
        patched,
        caller: parentAgent.configuration,
      });
      if (reasons.length) {
        return {
          status: "error",
          error: meridianErrorFromSystem("spawn_invocation_authority_denied", reasons.join(" ")),
        };
      }
      configuration = patched;
    }

    if (revision) {
      const unavailable = deps.unavailableReasons(revision.definition, configuration.model);
      if (unavailable.length) {
        return {
          status: "error",
          error: meridianErrorFromSystem("spawn_agent_unavailable", unavailable.join(" ")),
        };
      }
    } else {
      const unavailable = deps.modelUnavailable(configuration.model);
      if (unavailable.length) {
        return {
          status: "error",
          error: meridianErrorFromSystem("spawn_agent_unavailable", unavailable.join(" ")),
        };
      }
    }

    const invocationOverlay: InvocationOverlay | null =
      input.appendSystemPrompt !== undefined || input.overrides !== undefined
        ? {
            ...(input.appendSystemPrompt !== undefined
              ? { appendSystemPrompt: input.appendSystemPrompt }
              : {}),
            ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
          }
        : null;

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
      if (options.background) {
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
      const prepared = await registerPreparedChild(child, resolvedSlug, {
        background: options.background,
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

  async function prepareExistingChild(
    input: ContinueChildInput,
    target: ContinueTarget,
    options: { background?: boolean } = {},
  ): Promise<PreparedChild | SpawnResult> {
    const turnError = assertTurnBudget(input.budget);
    if (turnError) return { status: "error", error: turnError };

    const binding = await deps.agentRevisions.readThreadBinding(target.thread.id);
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
      return await registerPreparedChild(target.thread, resolvedSlug, {
        background: options.background,
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

  async function registerPreparedChild(
    child: Thread,
    resolvedSlug: string,
    options: { background?: boolean; signal?: AbortSignal; origin: "spawn" | "continue" },
  ): Promise<PreparedChild> {
    const parentThreadId = child.parentThreadId as ThreadId;
    const childThreadId = child.id as ThreadId;
    const childController = new AbortController();
    let runClaim: ThreadRunClaim | null = null;
    try {
      runClaim = await runOwnership.tryAcquire(childThreadId);
      if (!runClaim) throw new Error(`Child thread already has an active run: ${child.id}`);
      if (options.background) {
        deps.childRunRegistry.registerBackgroundChild(
          parentThreadId,
          childThreadId,
          childController,
        );
      } else {
        const parentSignal = options.signal;
        if (parentSignal) {
          if (parentSignal.aborted) {
            childController.abort();
          } else {
            parentSignal.addEventListener("abort", () => childController.abort(), { once: true });
          }
        }
        deps.childRunRegistry.registerChild(parentThreadId, childThreadId, childController);
      }
      return {
        child,
        resolvedSlug,
        childController,
        childRegistered: true,
        runClaim,
        background: options.background ?? false,
        origin: options.origin,
      };
    } catch (error) {
      childController.abort();
      deps.childRunRegistry.unregisterChild(childThreadId);
      await runClaim?.release();
      throw error;
    }
  }

  /** Releases a prepared child that never entered driveChild (e.g. a card write failed). */
  async function releasePreparedChild(prepared: PreparedChild): Promise<void> {
    prepared.childController.abort();
    deps.childRunRegistry.unregisterChild(prepared.child.id as ThreadId);
    await prepared.runClaim.release();
  }

  /** Persists the running card; a write failure releases the prepared child's claim. */
  async function persistRunningCard(
    transcript: SpawnTranscript | undefined,
    fields: Parameters<typeof persistHelperCard>[1],
    prepared: PreparedChild,
  ): Promise<Block | null> {
    try {
      return await persistHelperCard(transcript, fields);
    } catch (error) {
      await releasePreparedChild(prepared);
      throw error;
    }
  }

  async function driveChild(input: ChildDriveInput, prepared: PreparedChild): Promise<SpawnResult> {
    let terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
    let spawnResult: SpawnResult = {
      status: "error",
      error: meridianErrorFromSystem("spawn_failed", "Child run did not produce a result"),
    };
    let reportId: TurnId | null = null;

    // Background reports are recorded durably the moment return_result settles,
    // not only in driveChild's terminal transaction, so a crash between the two
    // cannot lose the payload/artifacts; `enqueue` is idempotent on reportId.
    const enqueueBackgroundReport = async (result: SpawnResult) => {
      if (!prepared.background) return;
      await deps.childReportDelivery.enqueue({
        reportId: reportId ?? (crypto.randomUUID() as TurnId),
        parentThreadId: input.parentThread.id as ThreadId,
        childThreadId: prepared.child.id as ThreadId,
        agentSlug: prepared.resolvedSlug,
        ...(prepared.description !== undefined ? { description: prepared.description } : {}),
        result,
      });
    };

    try {
      const handle = await deps.orchestrator.runTurn({
        threadId: prepared.child.id as ThreadId,
        userText: input.prompt,
        signal: prepared.childController.signal,
        treeBudget: input.budget,
        isSubagentThread: true,
        returnResultCompleter: createReturnResultCompleter(prepared.child.id as ThreadId, {
          onCapture: async (capture) => {
            if (!reportId) return;
            await enqueueBackgroundReport({
              status: "completed",
              report: {
                threadId: prepared.child.id,
                summary: capture.summary,
                ...(capture.payload !== undefined ? { payload: capture.payload } : {}),
                ...(capture.artifacts !== undefined ? { artifacts: capture.artifacts } : {}),
                costMillicredits: 0,
              },
            });
          },
        }),
      });
      reportId = handle.assistantTurnId;
      deps.childRunRegistry.markChildTurn(
        prepared.child.id as ThreadId,
        handle.assistantTurnId as TurnId,
      );

      let childTerminal: ChildTerminal | null = null;
      for await (const event of handle.events) {
        if (event.type === "turn.completed") childTerminal = { type: "completed" };
        else if (event.type === "turn.cancelled") childTerminal = { type: "cancelled" };
        else if (event.type === "turn.error") {
          childTerminal = { type: "error", message: event.error.message, code: event.error.code };
        }
      }

      const childCostMillicredits = Number(
        await deps.billingSpendReader.getThreadDebitTotal({
          userId: input.parentThread.userId,
          threadId: prepared.child.id,
        }),
      );
      const captured = pendingReports.get(prepared.child.id);
      pendingReports.delete(prepared.child.id);

      if (captured) {
        spawnResult = {
          status: "completed",
          report: { ...captured, costMillicredits: childCostMillicredits },
        };
      } else if (childTerminal?.type === "cancelled") {
        terminalStatus = "cancelled";
        spawnResult = {
          status: "error",
          error: meridianErrorFromSystem("spawn_cancelled", "Child run was cancelled"),
        };
      } else if (childTerminal?.type === "error") {
        terminalStatus = "failed";
        spawnResult = {
          status: "error",
          error: meridianErrorFromSystem(
            childTerminal.code || "spawn_failed",
            childTerminal.message || "Child run failed",
          ),
        };
      } else if (childTerminal?.type === "completed") {
        spawnResult = {
          status: "completed",
          report: await synthesizeIncompleteReport(
            deps.repos,
            prepared.child.id as ThreadId,
            childCostMillicredits,
          ),
        };
      } else {
        terminalStatus = "failed";
        spawnResult = {
          status: "error",
          error: meridianErrorFromSystem("spawn_failed", "Child run ended without terminal event"),
        };
      }
    } catch (error) {
      terminalStatus = "failed";
      const message = error instanceof Error ? error.message : String(error);
      spawnResult = { status: "error", error: meridianErrorFromSystem("spawn_failed", message) };
    } finally {
      try {
        await deps.repos.transaction(async () => {
          // spawn_status/spawn_result record the spawn; a continue run's outcome
          // lives on its per-execution card and events and never erases it.
          if (prepared.origin === "spawn") {
            await deps.repos.threads.updateSpawnLifecycle(prepared.child.id as ThreadId, {
              spawnStatus: terminalStatus,
              spawnResult,
            });
          }
          await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
            type: "agent.run_completed",
            parentThreadId: input.parentThread.id,
            parentTurnId: input.parentTurnId as string,
            childThreadId: prepared.child.id,
            result: spawnResult,
          });
          await enqueueBackgroundReport(spawnResult);
        });
      } finally {
        deps.childRunRegistry.abortChildrenOf(prepared.child.id as ThreadId, {
          includeBackground: true,
        });
        try {
          if (prepared.childRegistered) {
            try {
              await deps.workContextDelivery.flushOwned(prepared.child.id as ThreadId);
            } finally {
              deps.childRunRegistry.unregisterChild(prepared.child.id as ThreadId);
            }
          }
        } finally {
          await prepared.runClaim.release();
        }
      }
    }

    return spawnResult;
  }

  function driveBackground(input: ChildDriveInput, prepared: PreparedChild): void {
    void driveChild(input, prepared)
      .then(async (result) => {
        if (result.status === "completed") {
          await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
            type: "background.completed",
            parentThreadId: input.parentThread.id,
            parentTurnId: input.parentTurnId as string,
            childThreadId: prepared.child.id,
            agentSlug: prepared.resolvedSlug,
            result,
          });
        } else {
          await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
            type: "background.failed",
            parentThreadId: input.parentThread.id,
            parentTurnId: input.parentTurnId as string,
            childThreadId: prepared.child.id,
            agentSlug: prepared.resolvedSlug,
            error: result.status === "error" ? result.error.message : "Background run failed",
          });
        }
      })
      .catch(async (error: unknown) => {
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "background.failed",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: prepared.child.id,
          agentSlug: prepared.resolvedSlug,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  const coordinator: ChildRunCoordinator = {
    createReturnResultCompleter,

    async spawnChild(input: SpawnChildInput): Promise<SpawnResult> {
      const cardFields = {
        agent: input.agentSlug,
        description: input.description,
        parentTurnId: input.parentTurnId as string,
      };
      let runningCard: Block | null = null;
      try {
        const prepared = await prepareChild(input);
        if ("status" in prepared) {
          await persistHelperCard(input.transcript, { ...cardFields, output: prepared });
          return prepared;
        }
        runningCard = await persistRunningCard(
          input.transcript,
          {
            ...cardFields,
            childThreadId: prepared.child.id,
          },
          prepared,
        );
        const result = await driveChild(input, prepared);
        await persistHelperCard(
          input.transcript,
          { ...cardFields, childThreadId: prepared.child.id, output: result },
          runningCard,
        );
        return result;
      } catch (error) {
        await persistHelperCard(
          input.transcript,
          {
            ...cardFields,
            output: {
              status: "error",
              error: meridianErrorFromSystem(
                "spawn_failed",
                error instanceof Error ? error.message : String(error),
              ),
            },
          },
          runningCard,
        );
        throw error;
      }
    },

    async spawnChildBackground(input: SpawnChildInput): Promise<SpawnResult> {
      const prepared = await prepareChild(input, { background: true });
      if ("status" in prepared) return prepared;

      driveBackground(input, prepared);

      return {
        status: "background",
        threadId: prepared.child.id,
        agentSlug: prepared.resolvedSlug,
        description: input.description,
      };
    },

    async continueChild(input: ContinueChildInput): Promise<SpawnResult> {
      const authorized = await authorizeContinueTarget({
        callerThread: input.parentThread,
        targetThreadId: input.childThreadId,
        threads: deps.repos.threads,
      });
      if (!authorized.ok) return { status: "error", error: authorized.error };

      const prepared = await prepareExistingChild(input, authorized.target);
      if ("status" in prepared) return prepared;

      const cardFields = {
        agent: prepared.resolvedSlug,
        parentTurnId: input.parentTurnId as string,
        childThreadId: prepared.child.id,
      };
      let runningCard: Block | null = null;
      try {
        runningCard = await persistRunningCard(input.transcript, cardFields, prepared);
        const result = await driveChild(input, prepared);
        await persistHelperCard(input.transcript, { ...cardFields, output: result }, runningCard);
        return result;
      } catch (error) {
        await persistHelperCard(
          input.transcript,
          {
            ...cardFields,
            output: {
              status: "error",
              error: meridianErrorFromSystem(
                "continue_failed",
                error instanceof Error ? error.message : String(error),
              ),
            },
          },
          runningCard,
        );
        throw error;
      }
    },

    async continueChildBackground(input: ContinueChildInput): Promise<SpawnResult> {
      const authorized = await authorizeContinueTarget({
        callerThread: input.parentThread,
        targetThreadId: input.childThreadId,
        threads: deps.repos.threads,
      });
      if (!authorized.ok) return { status: "error", error: authorized.error };

      const prepared = await prepareExistingChild(input, authorized.target, { background: true });
      if ("status" in prepared) return prepared;

      driveBackground(input, prepared);

      return {
        status: "background",
        threadId: prepared.child.id,
        agentSlug: prepared.resolvedSlug,
      };
    },
  };

  return coordinator;
}
