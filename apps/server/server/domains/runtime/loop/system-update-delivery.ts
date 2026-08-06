/** Queues refreshed Work context and appends it as a user-role transcript turn. */
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, ThreadListItem, Turn } from "@meridian/contracts/threads";
import type { WorkContextUpdates } from "../../projects/index.js";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import {
  type EventJournalWriter,
  type ThreadRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { persistAndAppendTurnStartEvents } from "./persistence.js";
import type { WorkContextReader } from "./work-context.js";

export interface SystemUpdateDelivery extends WorkContextUpdates {
  flush(threadId: ThreadId): Promise<void>;
  /** Persist an update at the current head and return its local context rows. */
  deliverNow(
    threadId: ThreadId,
  ): Promise<{ turn: Turn; block: Block; events: OrchestratorEvent[] }>;
}

function localUserTurn(threadId: ThreadId, prevTurnId: TurnId | null): Turn {
  const now = toIsoString(new Date());
  return {
    id: crypto.randomUUID(),
    threadId,
    prevTurnId,
    parentTurnId: prevTurnId,
    role: "user",
    writeMode: null,
    status: "complete",
    finishReason: null,
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
      totalMillicredits: "0",
      responseCount: 0,
    },
    error: null,
    requestParams: null,
    responseMetadata: null,
    metadata: { kind: "system_update", section: "work_context" },
    createdAt: now,
    completedAt: now,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function receivesWorkUpdates(thread: ThreadListItem): boolean {
  return thread.status !== "archived" && thread.bakedSkillSlugs !== null;
}

export function createSystemUpdateDelivery(deps: {
  repos: Pick<
    ThreadRepositories,
    "blocks" | "modelResponses" | "threads" | "transaction" | "turns" | "runTurnStartTransition"
  >;
  eventWriter: EventJournalWriter;
  workContext: WorkContextReader;
  isThreadRunning(threadId: ThreadId): boolean;
}): SystemUpdateDelivery {
  const pending = new Set<string>();
  const flushChains = new Map<string, Promise<void>>();

  async function append(threadId: ThreadId) {
    // The database head is the concurrency invariant. A racing turn start may
    // win between this read and transition; retry from its new head rather
    // than creating a sibling and replacing active history.
    for (let attempt = 0; ; attempt += 1) {
      const context = await deps.workContext.renderForThread(threadId);
      const thread = await deps.repos.threads.findById(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      const expected = (thread.activeLeafTurnId as TurnId | null) ?? null;
      const turn = localUserTurn(threadId, expected);
      const block = contentForBlockInput({
        turnId: turn.id,
        blockType: "text",
        sequence: 0,
        textContent: `<system_update>\n${context}\n</system_update>`,
        status: "complete",
      });
      const events: OrchestratorEvent[] = [
        { type: "turn.created", turn },
        { type: "block.upserted", block },
      ];
      try {
        const persisted = await persistAndAppendTurnStartEvents(
          deps,
          threadId,
          expected,
          async () => ({ result: { turn, block: localBlockFromEvent(block) }, events }),
        );
        return { ...persisted.result, events: persisted.events };
      } catch (error) {
        if (!(error instanceof TurnStartConflictError) || attempt >= 2) throw error;
      }
    }
  }

  async function flushUnlocked(threadId: ThreadId): Promise<void> {
    const key = threadId as string;
    if (!pending.delete(key)) return;
    if (deps.isThreadRunning(threadId)) {
      pending.add(key);
      return;
    }
    await append(threadId);
  }

  const delivery: SystemUpdateDelivery = {
    async threadChanged(threadId) {
      const thread = await deps.repos.threads.findById(threadId);
      if (!thread || thread.status === "archived" || thread.bakedSkillSlugs === null) return;
      const key = threadId as string;
      pending.add(key);
      if (!deps.isThreadRunning(threadId)) await delivery.flush(threadId);
    },

    async projectChanged(projectId: ProjectId) {
      const threads = await deps.repos.threads.listByProject(projectId);
      await Promise.all(
        threads.filter(receivesWorkUpdates).map((thread) => delivery.threadChanged(thread.id)),
      );
    },

    async deliverNow(threadId) {
      pending.delete(threadId as string);
      return append(threadId);
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
  return delivery;
}
