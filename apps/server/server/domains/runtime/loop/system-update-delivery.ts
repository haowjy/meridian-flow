/** Queues refreshed Work context and appends it as a user-role transcript turn. */
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent, ThreadListItem, Turn } from "@meridian/contracts/threads";
import type { WorkContextUpdates } from "../../projects/index.js";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type { EventJournalWriter, ThreadRepositories } from "../../threads/index.js";
import { contentForBlockInput } from "./block-helpers.js";
import { persistAndAppendEvents } from "./persistence.js";
import type { WorkContextReader } from "./work-context.js";

export interface SystemUpdateDelivery extends WorkContextUpdates {
  flush(threadId: ThreadId): Promise<void>;
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

  async function append(threadId: ThreadId): Promise<void> {
    const context = await deps.workContext.renderForThread(threadId);
    const leaf = await deps.repos.turns.getLatestByThread(threadId);
    const turn = localUserTurn(threadId, (leaf?.id as TurnId | undefined) ?? null);
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
    await persistAndAppendEvents(deps, threadId, async () => ({ result: undefined, events }));
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
