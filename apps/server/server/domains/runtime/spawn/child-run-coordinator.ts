/**
 * ChildRunCoordinator: owns subagent thread lifecycle, drives child runTurn to
 * terminal state, captures return_result, and persists spawnStatus/spawnResult.
 * The sole caller allowed through the thread-create spawn gate.
 */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AgentReport,
  ReturnResultCapture,
  SpawnResult,
  TreeBudget,
} from "@meridian/contracts/spawn";
import { blockPlainText, type Thread } from "@meridian/contracts/threads";
import type { BillingSpendReader } from "../../billing/index.js";
import {
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
import type { ReturnResultCompleter, RunTurnPort } from "../loop/run-turn-port.js";
import {
  createInMemoryThreadRunOwnership,
  type ThreadRunClaim,
  type ThreadRunOwnership,
} from "../loop/thread-run-ownership.js";
import type { ChildRunRegistry } from "../loop/turn-runner.js";
import type { HelperResultDelivery } from "./helper-result-delivery.js";
import { assertSpawnDepthAllowed, assertTurnBudget } from "./tree-budget.js";

export interface SpawnChildInput {
  parentThread: Thread;
  parentTurnId: TurnId;
  agentSlug: string;
  prompt: string;
  description?: string;
  budget: TreeBudget;
  signal?: AbortSignal;
}

export interface ChildRunCoordinatorDeps {
  orchestrator: RunTurnPort;
  repos: {
    threads: Pick<ThreadRepository, "updateSpawnLifecycle">;
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
  childRunRegistry: ChildRunRegistry;
  helperResultDelivery: HelperResultDelivery;
  workContextDelivery: Pick<WorkContextDelivery, "flushOwned">;
  runOwnership?: ThreadRunOwnership;
  billingSpendReader: BillingSpendReader;
}

export interface ChildRunCoordinator {
  spawnChild(input: SpawnChildInput): Promise<SpawnResult>;
  spawnChildBackground(input: SpawnChildInput): Promise<SpawnResult>;
  createReturnResultCompleter(childThreadId: ThreadId): ReturnResultCompleter;
}

type ChildTerminal =
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; message: string; code: string };

type PreparedChild = {
  child: Thread;
  childController: AbortController;
  childRegistered: boolean;
  runClaim: ThreadRunClaim;
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

  function createReturnResultCompleter(childThreadId: ThreadId): ReturnResultCompleter {
    return async (capture: ReturnResultCapture) => {
      pendingReports.set(childThreadId as string, {
        threadId: childThreadId as string,
        summary: capture.summary,
        payload: capture.payload,
        artifacts: capture.artifacts,
        costMillicredits: 0,
      });
      deps.childRunRegistry.abortChild(childThreadId);
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
    const target = parentAgent?.configuration.namedTargets.find(
      (item) => item.name === input.agentSlug,
    );
    if (!target) {
      return {
        status: "error",
        error: meridianErrorFromSystem(
          "spawn_agent_not_allowed",
          `Agent "${input.agentSlug}" is not in caller subagents`,
        ),
      };
    }

    const childAgent = await deps.agentRevisions.readRevision(target.definitionRevisionId);
    if (
      !childAgent ||
      childAgent.definition.metadata.mode === "primary" ||
      childAgent.definition.metadata["model-invocable"] === false
    ) {
      return {
        status: "error",
        error: meridianErrorFromSystem(
          "spawn_agent_not_found",
          `Agent "${input.agentSlug}" is unavailable in the caller's retained package`,
        ),
      };
    }

    const configuration = await resolveAgentConfiguration({
      revision: childAgent,
      store: deps.agentRevisions,
      defaultModel: deps.defaultModel(),
    });
    const unavailable = deps.unavailableReasons(childAgent.definition, configuration.model);
    if (unavailable.length) {
      return {
        status: "error",
        error: meridianErrorFromSystem("spawn_agent_unavailable", unavailable.join(" ")),
      };
    }
    const child = await deps.repos.transaction(async () => {
      const created = await createBoundConversation({
        transaction: deps.repos.transaction,
        agentRevisions: deps.agentRevisions,
        revision: childAgent,
        configuration,
        createThread: () =>
          deps.repos.subagentThreads.createSubagent({
            userId: input.parentThread.userId,
            projectId: input.parentThread.projectId,
            parentThreadId: input.parentThread.id as ThreadId,
            rootThreadId: input.parentThread.rootThreadId as ThreadId,
            originTurnId: input.parentTurnId,
            spawnDepth: input.parentThread.spawnDepth + 1,
            title: input.description ?? `${input.agentSlug} subagent`,
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
        agentSlug: input.agentSlug,
        prompt: input.prompt,
      });
      if (options.background) {
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "background.started",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: created.id,
          agentSlug: input.agentSlug,
          description: input.description,
        });
      }
      return created;
    });

    const childController = new AbortController();
    let runClaim: ThreadRunClaim | null = null;
    try {
      runClaim = await runOwnership.tryAcquire(child.id as ThreadId);
      if (!runClaim) throw new Error(`Child thread already has an active run: ${child.id}`);
      let childRegistered = false;
      if (options.background) {
        deps.childRunRegistry.registerBackgroundChild(
          input.parentThread.id as ThreadId,
          child.id as ThreadId,
          childController,
        );
        childRegistered = true;
      } else {
        const parentSignal = input.signal;
        if (parentSignal) {
          if (parentSignal.aborted) {
            childController.abort();
          } else {
            parentSignal.addEventListener("abort", () => childController.abort(), { once: true });
          }
        }
        deps.childRunRegistry.registerChild(
          input.parentThread.id as ThreadId,
          child.id as ThreadId,
          childController,
        );
        childRegistered = true;
      }
      return { child, childController, childRegistered, runClaim };
    } catch (error) {
      childController.abort();
      deps.childRunRegistry.unregisterChild(child.id as ThreadId);
      try {
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
            type: "agent.spawn_completed",
            parentThreadId: input.parentThread.id,
            parentTurnId: input.parentTurnId as string,
            childThreadId: child.id,
            result,
          });
        });
      } finally {
        await runClaim?.release();
      }
      throw error;
    }
  }

  async function driveChild(input: SpawnChildInput, prepared: PreparedChild): Promise<SpawnResult> {
    let terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
    let spawnResult: SpawnResult = {
      status: "error",
      error: meridianErrorFromSystem("spawn_failed", "Child run did not produce a result"),
    };

    try {
      const handle = await deps.orchestrator.runTurn({
        threadId: prepared.child.id as ThreadId,
        userText: input.prompt,
        signal: prepared.childController.signal,
        treeBudget: input.budget,
        isSubagentThread: true,
        returnResultCompleter: createReturnResultCompleter(prepared.child.id as ThreadId),
      });
      deps.helperResultDelivery.markRunning(
        prepared.child.id as ThreadId,
        handle.assistantTurnId as TurnId,
      );
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
        await deps.repos.threads.updateSpawnLifecycle(prepared.child.id as ThreadId, {
          spawnStatus: terminalStatus,
          spawnResult,
        });
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "agent.spawn_completed",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: prepared.child.id,
          result: spawnResult,
        });
      } finally {
        deps.childRunRegistry.abortChildrenOf(prepared.child.id as ThreadId, {
          includeBackground: true,
        });
        try {
          await deps.helperResultDelivery.markIdleAndFlush(prepared.child.id as ThreadId);
        } finally {
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
    }

    return spawnResult;
  }

  async function deliverHelperResult(
    input: SpawnChildInput,
    child: Thread,
    result: SpawnResult,
  ): Promise<void> {
    await deps.helperResultDelivery.deliverOrQueue({
      parentThread: input.parentThread,
      parentTurnId: input.parentTurnId,
      agentSlug: input.agentSlug,
      description: input.description,
      childThreadId: child.id,
      result,
    });
  }

  const coordinator: ChildRunCoordinator = {
    createReturnResultCompleter,

    async spawnChild(input: SpawnChildInput): Promise<SpawnResult> {
      const prepared = await prepareChild(input);
      if ("status" in prepared) return prepared;
      return driveChild(input, prepared);
    },

    async spawnChildBackground(input: SpawnChildInput): Promise<SpawnResult> {
      const prepared = await prepareChild(input, { background: true });
      if ("status" in prepared) return prepared;

      void driveChild(input, prepared)
        .then(async (result) => {
          if (result.status === "completed") {
            await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
              type: "background.completed",
              parentThreadId: input.parentThread.id,
              parentTurnId: input.parentTurnId as string,
              childThreadId: prepared.child.id,
              agentSlug: input.agentSlug,
              result,
            });
          } else {
            await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
              type: "background.failed",
              parentThreadId: input.parentThread.id,
              parentTurnId: input.parentTurnId as string,
              childThreadId: prepared.child.id,
              agentSlug: input.agentSlug,
              error: result.status === "error" ? result.error.message : "Background run failed",
            });
          }
          await deliverHelperResult(input, prepared.child, result);
        })
        .catch(async (error: unknown) => {
          await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
            type: "background.failed",
            parentThreadId: input.parentThread.id,
            parentTurnId: input.parentTurnId as string,
            childThreadId: prepared.child.id,
            agentSlug: input.agentSlug,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return {
        status: "background",
        threadId: prepared.child.id,
        agentSlug: input.agentSlug,
        description: input.description,
      };
    },
  };

  return coordinator;
}
