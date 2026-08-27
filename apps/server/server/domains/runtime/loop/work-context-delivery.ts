/** Queues refreshed Work context and appends it as a user-role transcript turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { WorkContextDelivery } from "../../projects/index.js";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import {
  type EventJournalWriter,
  type ThreadRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import { contentForBlockInput, isJsonObject, localBlockFromEvent } from "./block-helpers.js";
import { persistAndAppendTurnStartEvents } from "./persistence.js";
import {
  createInMemoryThreadRunOwnership,
  type ThreadRunOwnership,
} from "./thread-run-ownership.js";
import type { WorkContextReader } from "./work-context.js";

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

export function createWorkContextDelivery(deps: {
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
  runOwnership?: ThreadRunOwnership;
  /** Schedule a non-blocking wake after the caller's business transaction commits. */
  schedulePostCommit(task: () => Promise<void>): void;
}): WorkContextDelivery {
  const runOwnership = deps.runOwnership ?? createInMemoryThreadRunOwnership();
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
      // Pending selection and run ownership are intentionally outside the
      // thread-head transaction. Revalidate visibility before canonical load;
      // lockPending repeats this check under the transition lock below.
      if (!(await deps.repos.workContextDeliveries.lockPending(threadId))) return null;
      const thread = await deps.repos.threads.findById(threadId);
      if (!thread) {
        if (attempt < 2) continue;
        throw new Error(`Thread not found: ${threadId}`);
      }
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
            const rendered = await deps.workContext.renderForThread(threadId);
            const turn = localUserTurn(threadId, expected);
            const block = contentForBlockInput({
              turnId: turn.id,
              blockType: "text",
              sequence: 0,
              textContent: `<system_update>\n${rendered.text}\n</system_update>`,
              status: "complete",
            });
            const events: OrchestratorEvent[] = [
              { type: "turn.created", turn },
              { type: "block.upserted", block },
              {
                type: "work_context.changed",
                turnId: turn.id,
                threadId,
                projectId: rendered.current.projectId,
                workId: rendered.current.workId,
              },
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

  async function hydrateCommittedUpdate(threadId: ThreadId) {
    const turns = await deps.repos.turns.listByThread(threadId);
    const turn = [...turns].reverse().find((candidate) => {
      const metadata = candidate.metadata ?? null;
      return (
        isJsonObject(metadata) &&
        metadata.kind === "system_update" &&
        metadata.section === "work_context"
      );
    });
    if (!turn) return null;
    const blocks = await deps.repos.blocks.listByTurn(turn.id);
    const block = blocks.find((candidate) => candidate.blockType === "text");
    return block ? { turn, block, events: [] as OrchestratorEvent[] } : null;
  }

  async function flushUnlocked(threadId: ThreadId): Promise<void> {
    if (deps.isThreadRunning(threadId)) return;
    const claim = await runOwnership.tryAcquire(threadId);
    if (!claim) return;
    try {
      await append(threadId);
    } finally {
      await claim.release();
    }
  }

  async function flush(threadId: ThreadId): Promise<void> {
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
  }

  const delivery: WorkContextDelivery = {
    async threadChanged(threadId) {
      const threadIds = await deps.repos.workContextDeliveries.enqueueThread(threadId);
      deps.schedulePostCommit(() => Promise.all(threadIds.map(flush)).then(() => undefined));
    },

    async projectChanged(projectId) {
      const threadIds = await deps.repos.workContextDeliveries.enqueueProject(projectId);
      deps.schedulePostCommit(() => Promise.all(threadIds.map(flush)).then(() => undefined));
    },

    async deliverNow(threadId) {
      const update = await append(threadId);
      if (update) return update;
      const committed = await hydrateCommittedUpdate(threadId);
      if (committed) return committed;
      throw new Error("Work context delivery unexpectedly produced no update");
    },

    async beforeTurn(threadId) {
      await append(threadId);
    },

    async deliverAfterCommit(threadId) {
      try {
        await flush(threadId);
        return (await deps.repos.workContextDeliveries.isPending(threadId))
          ? "pending"
          : "delivered";
      } catch {
        return "pending";
      }
    },

    async flushOwned(threadId) {
      await append(threadId);
    },

    async sweep() {
      const threadIds = await deps.repos.workContextDeliveries.listPendingThreadIds();
      await Promise.all(threadIds.map(flush));
    },
  };
  return delivery;
}
