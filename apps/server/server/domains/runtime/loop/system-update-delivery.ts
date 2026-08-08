/** Queues refreshed Work context and appends it as a user-role transcript turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { WorkContextUpdates } from "../../projects/index.js";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import {
  type EventJournalWriter,
  type ThreadRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import { contentForBlockInput, isJsonObject, localBlockFromEvent } from "./block-helpers.js";
import { persistAndAppendTurnStartEvents } from "./persistence.js";
import type { WorkContextReader } from "./work-context.js";

export interface SystemUpdateDelivery extends WorkContextUpdates {
  flush(threadId: ThreadId): Promise<void>;
  /** Claim durable pending delivery before a new writer turn starts. */
  beforeTurn(threadId: ThreadId): Promise<void>;
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

export function createSystemUpdateDelivery(deps: {
  repos: Pick<
    ThreadRepositories,
    | "blocks"
    | "modelResponses"
    | "threads"
    | "transaction"
    | "turns"
    | "runTurnStartTransition"
    | "workContextDeliveries"
  >;
  eventWriter: EventJournalWriter;
  workContext: WorkContextReader;
  isThreadRunning(threadId: ThreadId): boolean;
}): SystemUpdateDelivery {
  const flushChains = new Map<string, Promise<void>>();

  function pendingPresentationBlocks(blocks: Block[]): Block[] {
    return blocks.filter((block) => {
      if (block.blockType !== "tool_result" || !isJsonObject(block.content)) return false;
      const metadata = block.content.metadata;
      return isJsonObject(metadata) && metadata.workContextDelivery === "pending";
    });
  }

  function acknowledgedPresentationEvents(block: Block): OrchestratorEvent[] {
    if (!isJsonObject(block.content)) return [];
    const content = block.content;
    const output = isJsonObject(content.output) ? content.output : null;
    const metadata = isJsonObject(content.metadata) ? content.metadata : {};
    const { contextUpdate: _contextUpdate, ...deliveredOutput } = output ?? {};
    const { workContextWarning: _warning, ...deliveredMetadata } = metadata;
    const acknowledgedMetadata = { ...deliveredMetadata, workContextDelivery: "delivered" };
    const acknowledged = contentForBlockInput({
      id: block.id,
      turnId: block.turnId as TurnId,
      ...(block.responseId ? { responseId: block.responseId } : {}),
      blockType: "tool_result",
      sequence: block.sequence,
      content: {
        ...content,
        output: deliveredOutput,
        metadata: acknowledgedMetadata,
      },
      status: block.status,
    });
    return [
      { type: "block.upserted", block: acknowledged },
      {
        type: "tool.result",
        toolCallId: typeof content.toolCallId === "string" ? content.toolCallId : block.id,
        output: deliveredOutput,
        ...(typeof content.isError === "boolean" ? { isError: content.isError } : {}),
        metadata: acknowledgedMetadata,
      },
    ];
  }

  async function append(threadId: ThreadId) {
    // The database head is the concurrency invariant. A racing turn start may
    // win between this read and transition; retry from its new head rather
    // than creating a sibling and replacing active history.
    for (let attempt = 0; ; attempt += 1) {
      const thread = await deps.repos.threads.findById(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      const expected = (thread.activeLeafTurnId as TurnId | null) ?? null;
      try {
        const persisted = await persistAndAppendTurnStartEvents(
          deps,
          threadId,
          expected,
          async () => {
            if (!(await deps.repos.workContextDeliveries.lockPending(threadId))) {
              return { result: null, events: [] };
            }
            // This metadata is model-facing status only. The obligation above
            // is the sole recovery and claim authority.
            const pendingBlocks = pendingPresentationBlocks(
              await deps.repos.blocks.listByThread(threadId),
            );
            const context = await deps.workContext.renderForThread(threadId);
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
              ...pendingBlocks.flatMap(acknowledgedPresentationEvents),
            ];
            // The surrounding turn-start transaction makes this deletion atomic
            // with both read-model projection and journal append. Any failure
            // rolls the obligation back for the next claim.
            await deps.repos.workContextDeliveries.acknowledge(threadId);
            return { result: { turn, block: localBlockFromEvent(block) }, events };
          },
        );
        return persisted.result ? { ...persisted.result, events: persisted.events } : null;
      } catch (error) {
        if (!(error instanceof TurnStartConflictError) || attempt >= 2) throw error;
      }
    }
  }

  async function flushUnlocked(threadId: ThreadId): Promise<void> {
    if (deps.isThreadRunning(threadId)) return;
    await append(threadId);
  }

  const delivery: SystemUpdateDelivery = {
    async threadChanged(threadId) {
      await deps.repos.workContextDeliveries.enqueueThread(threadId);
    },

    async projectChanged(projectId) {
      await deps.repos.workContextDeliveries.enqueueProject(projectId);
    },

    async deliverNow(threadId) {
      const update = await append(threadId);
      if (!update) throw new Error("Work context delivery unexpectedly produced no update");
      return update;
    },

    async beforeTurn(threadId) {
      await append(threadId);
    },

    async flush(threadId) {
      const key = threadId as string;
      const previous = flushChains.get(key) ?? Promise.resolve();
      const next = previous.then(() => flushUnlocked(threadId));
      const settled = next.catch(() => undefined);
      flushChains.set(key, settled);
      try {
        await next;
      } finally {
        if (flushChains.get(key) === settled) flushChains.delete(key);
      }
    },
  };
  return delivery;
}
