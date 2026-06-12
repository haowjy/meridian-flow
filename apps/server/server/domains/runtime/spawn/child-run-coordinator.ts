// @ts-nocheck
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
import type { CreditLedger } from "../../billing/index.js";
import type { PackageRepository } from "../../packages/index.js";
import type {
  BlockRepository,
  EventJournalWriter,
  SubagentThreadFactory,
  ThreadRepository,
  TurnRepository,
} from "../../threads/index.js";
import { assembleComposedSystemPrompt } from "../loop/composed-system-prompt.js";
import type { ReturnResultCompleter, RunTurnPort } from "../loop/run-turn-port.js";
import type { ChildRunRegistry } from "../loop/turn-runner.js";
import { modelInvocableSkillSlugs, renderSkillsSystemPromptSection } from "../tools/skill-tools.js";
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
  };
  eventWriter: EventJournalWriter;
  packageRepository: PackageRepository;
  childRunRegistry: ChildRunRegistry;
  creditLedger: CreditLedger;
}

export interface ChildRunCoordinator {
  spawnChild(input: SpawnChildInput): Promise<SpawnResult>;
  createReturnResultCompleter(childThreadId: ThreadId): ReturnResultCompleter;
}

function subagentsFromMeta(meta: Record<string, unknown>): string[] {
  const raw = meta.subagents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

type ChildTerminal =
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; message: string; code: string };

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

  return {
    createReturnResultCompleter,

    async spawnChild(input: SpawnChildInput): Promise<SpawnResult> {
      const depthError = assertSpawnDepthAllowed(input.budget, input.parentThread.spawnDepth);
      if (depthError) {
        return { status: "error", error: depthError };
      }
      const turnError = assertTurnBudget(input.budget);
      if (turnError) {
        return { status: "error", error: turnError };
      }

      const packageContext = await deps.packageRepository.getAgentWithLinkedSkills(
        input.parentThread.workbenchId,
        input.parentThread.userId,
        input.parentThread.currentAgent ?? "",
      );
      const callerSubagents = packageContext.agent
        ? subagentsFromMeta(packageContext.agent.meta as Record<string, unknown>)
        : [];
      if (!callerSubagents.includes(input.agentSlug)) {
        return {
          status: "error",
          error: meridianErrorFromSystem(
            "spawn_agent_not_allowed",
            `Agent "${input.agentSlug}" is not in caller subagents`,
          ),
        };
      }

      const childAgentContext = await deps.packageRepository.getAgentWithLinkedSkills(
        input.parentThread.workbenchId,
        input.parentThread.userId,
        input.agentSlug,
      );
      if (!childAgentContext.agent) {
        return {
          status: "error",
          error: meridianErrorFromSystem(
            "spawn_agent_not_found",
            `Agent "${input.agentSlug}" not found`,
          ),
        };
      }

      let childThread: Thread | null = null;
      let childRegistered = false;
      let spawnEventAppended = false;
      let terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
      let spawnResult: SpawnResult = {
        status: "error",
        error: meridianErrorFromSystem("spawn_failed", "Child run did not produce a result"),
      };

      try {
        const child = await deps.repos.subagentThreads.createSubagent({
          userId: input.parentThread.userId,
          workbenchId: input.parentThread.workbenchId,
          workId: input.parentThread.workId,
          parentThreadId: input.parentThread.id as ThreadId,
          rootThreadId: input.parentThread.rootThreadId as ThreadId,
          spawnDepth: input.parentThread.spawnDepth + 1,
          currentAgent: input.agentSlug,
          composedSystemPrompt: assembleComposedSystemPrompt({
            basePrompt: childAgentContext.agent.body,
            skillsSystemPromptSection: renderSkillsSystemPromptSection(childAgentContext.skills),
          }),
          bakedSkillSlugs: modelInvocableSkillSlugs(childAgentContext.skills),
          title: input.description ?? `${input.agentSlug} subagent`,
          spawnStatus: "running",
        });
        childThread = child;

        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "agent.spawn",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: child.id,
          agentSlug: input.agentSlug,
          prompt: input.prompt,
        });
        spawnEventAppended = true;

        const childController = new AbortController();
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

        const handle = await deps.orchestrator.runTurn({
          threadId: child.id as ThreadId,
          userText: input.prompt,
          signal: childController.signal,
          treeBudget: input.budget,
          isSubagentThread: true,
          returnResultCompleter: createReturnResultCompleter(child.id as ThreadId),
        });

        let childTerminal: ChildTerminal | null = null;
        for await (const event of handle.events) {
          if (event.type === "turn.completed") {
            childTerminal = { type: "completed" };
          } else if (event.type === "turn.cancelled") {
            childTerminal = { type: "cancelled" };
          } else if (event.type === "turn.error") {
            childTerminal = {
              type: "error",
              message: event.error.message,
              code: event.error.code,
            };
          }
        }

        // DEFERRED(bigint-millicredits): pilot scale is orders of magnitude below 2^53; move to bigint/string end-to-end when balances can exceed it
        const childCostMillicredits = Number(
          await deps.creditLedger.getThreadDebitTotal({
            userId: input.parentThread.userId,
            workbenchId: input.parentThread.workbenchId,
            threadId: child.id,
          }),
        );
        const captured = pendingReports.get(child.id);
        pendingReports.delete(child.id);

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
              child.id as ThreadId,
              childCostMillicredits,
            ),
          };
        } else {
          terminalStatus = "failed";
          spawnResult = {
            status: "error",
            error: meridianErrorFromSystem(
              "spawn_failed",
              "Child run ended without terminal event",
            ),
          };
        }
      } catch (error) {
        terminalStatus = "failed";
        const message = error instanceof Error ? error.message : String(error);
        spawnResult = {
          status: "error",
          error: meridianErrorFromSystem("spawn_failed", message),
        };
      } finally {
        if (childThread && childRegistered) {
          deps.childRunRegistry.unregisterChild(childThread.id as ThreadId);
        }
      }

      if (childThread) {
        await deps.repos.threads.updateSpawnLifecycle(childThread.id as ThreadId, {
          spawnStatus: terminalStatus,
          spawnResult,
        });
      }

      if (childThread && spawnEventAppended) {
        await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
          type: "agent.spawn_completed",
          parentThreadId: input.parentThread.id,
          parentTurnId: input.parentTurnId as string,
          childThreadId: childThread.id,
          result: spawnResult,
        });
      }

      return spawnResult;
    },
  };
}
