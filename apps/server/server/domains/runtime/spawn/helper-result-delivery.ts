// @ts-nocheck
/**
 * Background helper result delivery: queue while the parent thread is streaming,
 * then append a system turn chained from the active leaf (never mutating an
 * in-flight assistant turn's block sequence).
 */
import { buildHelperResultComponentContent } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import type { OrchestratorEvent, Thread, Turn } from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type { EventJournalWriter } from "../../threads/index.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import type { OrchestratorRepositories } from "../loop/orchestrator.js";
import { persistAndAppendEvents } from "../loop/persistence.js";

export interface HelperResultDeliveryInput {
  parentThread: Thread;
  parentTurnId: TurnId;
  agentSlug: string;
  description?: string;
  childThreadId: string;
  result: SpawnResult;
}

export interface HelperResultDeliveryDeps {
  repos: OrchestratorRepositories;
  eventWriter: EventJournalWriter;
  getRunningTurnId(threadId: ThreadId): TurnId | null;
}

export interface HelperResultDelivery {
  deliverOrQueue(input: HelperResultDeliveryInput): Promise<void>;
  flush(threadId: ThreadId): Promise<void>;
  markRunning(threadId: ThreadId, turnId: TurnId): void;
  markIdleAndFlush(threadId: ThreadId): Promise<void>;
}

type PendingDelivery = HelperResultDeliveryInput;

function helperAgentName(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function helperSummary(result: SpawnResult): string {
  if (result.status === "completed") return result.report.summary;
  if (result.status === "error") return result.error.message;
  return "Running";
}

function createLocalSystemTurn(input: { threadId: ThreadId; parentTurnId: TurnId | null }): Turn {
  const now = toIsoString(new Date());
  return {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    prevTurnId: input.parentTurnId,
    parentTurnId: input.parentTurnId,
    role: "system",
    status: "complete",
    finishReason: "end_turn",
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    totalMillicredits: "0",
    responseCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalCostUsd: "0",
      responseCount: 0,
    },
    error: null,
    requestParams: null,
    responseMetadata: null,
    createdAt: now,
    completedAt: now,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export function createHelperResultDelivery(deps: HelperResultDeliveryDeps): HelperResultDelivery {
  const queues = new Map<string, PendingDelivery[]>();
  const flushChains = new Map<string, Promise<void>>();
  const locallyRunning = new Map<string, TurnId>();

  function runningTurnId(threadId: ThreadId): TurnId | null {
    return locallyRunning.get(threadId as string) ?? deps.getRunningTurnId(threadId);
  }

  async function deliverNow(input: HelperResultDeliveryInput): Promise<void> {
    const threadId = input.parentThread.id as ThreadId;
    const leafTurn = await deps.repos.turns.getLatestByThread(threadId);
    const parentTurnId = (leafTurn?.id ?? input.parentTurnId) as TurnId | null;
    const summary = helperSummary(input.result);
    const systemTurn = createLocalSystemTurn({ threadId, parentTurnId });
    const helperBlock = contentForBlockInput({
      turnId: systemTurn.id,
      blockType: "custom",
      sequence: 0,
      content: buildHelperResultComponentContent({
        agentSlug: input.agentSlug,
        agentName: helperAgentName(input.agentSlug),
        status: input.result.status === "completed" ? "completed" : "failed",
        summary,
        childThreadId: input.childThreadId,
        parentTurnId: input.parentTurnId as string,
        title: input.description,
        ...(input.result.status === "completed" && input.result.report.payload !== undefined
          ? { payload: input.result.report.payload }
          : {}),
      }),
      status: "complete",
    });

    const events: OrchestratorEvent[] = [
      { type: "turn.created", turn: systemTurn },
      { type: "block.upserted", block: helperBlock },
    ];

    await persistAndAppendEvents(deps, threadId, async () => ({
      result: systemTurn,
      events,
    }));
  }

  async function flushUnlocked(threadId: ThreadId): Promise<void> {
    const key = threadId as string;
    const pending = queues.get(key) ?? [];
    if (pending.length === 0) return;
    queues.delete(key);
    for (const delivery of pending) {
      await deliverNow(delivery);
    }
  }

  return {
    async deliverOrQueue(input) {
      const threadId = input.parentThread.id as ThreadId;
      if (runningTurnId(threadId)) {
        const key = threadId as string;
        const list = queues.get(key) ?? [];
        list.push(input);
        queues.set(key, list);
        return;
      }
      await deliverNow(input);
    },

    markRunning(threadId, turnId) {
      locallyRunning.set(threadId as string, turnId);
    },

    async markIdleAndFlush(threadId) {
      locallyRunning.delete(threadId as string);
      await this.flush(threadId);
    },

    async flush(threadId) {
      const key = threadId as string;
      const previous = flushChains.get(key) ?? Promise.resolve();
      const next = previous.then(() => flushUnlocked(threadId));
      flushChains.set(
        key,
        next.catch(() => undefined),
      );
      try {
        await next;
      } finally {
        if (flushChains.get(key) === next) flushChains.delete(key);
      }
    },
  };
}
