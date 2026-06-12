// @ts-nocheck
/**
 * In-memory ThreadRepositories: Map-backed thread/turn/block/model-response
 * repositories implementing the full repository ports (incl. the transaction
 * aggregate). For tests/local dev; shares creation semantics via thread-create.
 */

import type { ThreadDocumentRelationship } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, ModelResponse, Thread, Turn, TurnUsage } from "@meridian/contracts/threads";
import { toIsoString } from "../../domain/contract-serialization.js";
import { normalizeThreadCreate } from "../../domain/thread-create.js";
import { buildSubagentThreadRow } from "../../domain/thread-create-subagent.js";
import { toThreadListItem } from "../../domain/thread-list-projection.js";
import type {
  BlockRepository,
  CreateBlockInput,
  CreateModelResponseInput,
  CreateThreadInput,
  CreateTurnInput,
  InternalThreadRepositories,
  ModelResponseRepository,
  SubagentThreadFactory,
  ThreadDocument,
  ThreadDocumentRepository,
  ThreadRepository,
  TurnDocumentTouch,
  TurnDocumentTouchRepository,
  TurnRepository,
  UpdateSpawnLifecycleInput,
  UpdateTurnStatusInput,
} from "../../ports/repositories.js";

// USD rollups are display-side only; integer millicredits in the billing
// ledger are the money truth. Keep this local float helper out of billing
// decisions.
function addDecimal(a: string, b: string): string {
  return (parseFloat(a) + parseFloat(b)).toFixed(6);
}

function addBigIntString(
  a: string | null | undefined,
  b: string | null | undefined,
): string | undefined {
  if (b == null) return a ?? undefined;
  return (BigInt(a ?? "0") + BigInt(b)).toString();
}

function addOptionalInteger(
  current: number | null | undefined,
  delta: number | null | undefined,
): number | null {
  if (delta == null) return current ?? null;
  return (current ?? 0) + delta;
}

function emptyTurnUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    responseCount: 0,
  };
}

function defaultThread(input: CreateThreadInput): Thread {
  const normalized = normalizeThreadCreate(input);
  const now = toIsoString(new Date());
  const id = input.id ?? crypto.randomUUID();
  return {
    id,
    workbenchId: input.workbenchId,
    workId: input.workId ?? null,
    userId: input.userId,
    kind: normalized.kind,
    status: "idle",
    title: normalized.title === "" ? null : normalized.title,
    systemPrompt: normalized.systemPrompt,
    composedSystemPrompt: null,
    bakedSkillSlugs: null,
    workingState: input.workingState ?? null,
    currentAgent: normalized.currentAgent,
    nextSeq: "0",
    parentThreadId: normalized.parentThreadId,
    rootThreadId: id,
    spawnDepth: normalized.spawnDepth,
    spawnStatus: normalized.spawnStatus,
    spawnResult: null,
    totalCostUsd: "0",
    turnCount: 0,
    historySummary: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function defaultTurn(input: CreateTurnInput): Turn {
  const now = input.createdAt ?? toIsoString(new Date());
  return {
    id: input.id ?? crypto.randomUUID(),
    threadId: input.threadId,
    prevTurnId: input.prevTurnId ?? null,
    role: input.role,
    status: input.status ?? "pending",
    parentTurnId: input.prevTurnId ?? null,
    finishReason: null,
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    responseCount: 0,
    usage: emptyTurnUsage(),
    error: null,
    requestParams: input.requestParams ?? null,
    responseMetadata: null,
    createdAt: now,
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

interface WorkbenchVisibilityRepository {
  findById(id: string): Promise<{ deletedAt: string | null } | null>;
}

interface WorkProjectionRepository {
  findById(id: string): Promise<{ id: string; title: string; deletedAt: string | null } | null>;
}

export interface InMemoryRepositoriesOptions {
  workbenches?: WorkbenchVisibilityRepository;
  works?: WorkProjectionRepository;
}

export function createInMemoryRepositories(
  options: InMemoryRepositoriesOptions = {},
): InternalThreadRepositories {
  const threads = new Map<string, Thread>();
  const turns = new Map<string, Turn>();
  const blocks = new Map<string, Block>();
  const modelResponses = new Map<string, ModelResponse>();
  const threadDocuments = new Map<string, ThreadDocument>();
  const documentTouches = new Map<string, TurnDocumentTouch>();

  async function threadInActiveWorkbench(thread: Thread): Promise<boolean> {
    if (!options.workbenches) return true;
    const workbench = await options.workbenches.findById(thread.workbenchId);
    return Boolean(workbench && !workbench.deletedAt);
  }

  async function toListItem(thread: Thread) {
    const work =
      thread.workId && options.works ? await options.works.findById(thread.workId) : null;
    const threadTurns = [...turns.values()]
      .filter((turn) => turn.threadId === thread.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latestTurn = threadTurns.at(-1) ?? null;
    const runningTurn = [...threadTurns]
      .reverse()
      .find(
        (turn) =>
          turn.role === "assistant" &&
          (turn.status === "pending" ||
            turn.status === "streaming" ||
            turn.status === "waiting_checkpoint"),
      );

    return toThreadListItem({
      thread,
      workTitle: work && !work.deletedAt ? work.title : null,
      lastTurnRole: latestTurn?.role ?? null,
      lastTurnStatus: latestTurn?.status ?? null,
      runningTurnId: runningTurn?.id ?? null,
    });
  }

  const threadRepo: ThreadRepository & SubagentThreadFactory = {
    async create(input) {
      const thread = defaultThread(input);
      threads.set(thread.id, thread);
      return thread;
    },
    async createSubagent(input) {
      const thread = buildSubagentThreadRow(input);
      threads.set(thread.id, thread);
      return thread;
    },
    async updateSpawnLifecycle(id, input: UpdateSpawnLifecycleInput) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      const updated = {
        ...thread,
        spawnStatus: input.spawnStatus,
        spawnResult: input.spawnResult ?? thread.spawnResult ?? null,
        updatedAt: toIsoString(new Date()),
      };
      threads.set(id, updated);
      return updated;
    },
    async findById(id) {
      const thread = threads.get(id);
      if (!thread || thread.deletedAt || !(await threadInActiveWorkbench(thread))) return null;
      return thread;
    },
    async listByUser(userId) {
      const visible: Thread[] = [];
      for (const thread of threads.values()) {
        if (
          thread.userId === userId &&
          !thread.deletedAt &&
          (await threadInActiveWorkbench(thread))
        ) {
          visible.push(thread);
        }
      }
      return visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async listByWorkbench(workbenchId) {
      const visible: Thread[] = [];
      for (const thread of threads.values()) {
        if (
          thread.workbenchId === workbenchId &&
          !thread.deletedAt &&
          (await threadInActiveWorkbench(thread))
        ) {
          visible.push(thread);
        }
      }
      const ordered = visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return Promise.all(ordered.map(toListItem));
    },
    async listByWork(workbenchId, workId) {
      const visible: Thread[] = [];
      for (const thread of threads.values()) {
        if (
          thread.workbenchId === workbenchId &&
          thread.workId === workId &&
          !thread.deletedAt &&
          (await threadInActiveWorkbench(thread))
        ) {
          visible.push(thread);
        }
      }
      const ordered = visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return Promise.all(ordered.map(toListItem));
    },
    async updateStatus(id, status) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      const updated = { ...thread, status, updatedAt: toIsoString(new Date()) };
      threads.set(id, updated);
      return updated;
    },
    async updateCurrentAgent(id, currentAgent) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      if (
        thread.composedSystemPrompt !== null ||
        thread.bakedSkillSlugs !== null ||
        thread.turnCount > 0
      ) {
        return null;
      }
      const updated = { ...thread, currentAgent, updatedAt: toIsoString(new Date()) };
      threads.set(id, updated);
      return updated;
    },
    async bakeComposedSystemPrompt(id, input) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      if (thread.bakedSkillSlugs !== null) {
        return thread;
      }
      const updated = {
        ...thread,
        composedSystemPrompt: input.composedSystemPrompt,
        bakedSkillSlugs: input.bakedSkillSlugs,
        systemPrompt: null,
        updatedAt: toIsoString(new Date()),
      };
      threads.set(id, updated);
      return updated;
    },
    async recomputeCostFromModelResponses(id) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      let totalCostUsd = "0";
      for (const response of modelResponses.values()) {
        const turn = turns.get(response.turnId);
        if (turn?.threadId === id) {
          totalCostUsd = addDecimal(totalCostUsd, response.costUsd ?? "0");
        }
      }
      threads.set(id, {
        ...thread,
        totalCostUsd,
        updatedAt: toIsoString(new Date()),
      });
    },
    async updateCost(id, deltaCostUsd, turnCountIncrement = 0) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      threads.set(id, {
        ...thread,
        totalCostUsd: addDecimal(thread.totalCostUsd, deltaCostUsd),
        turnCount: thread.turnCount + turnCountIncrement,
        updatedAt: toIsoString(new Date()),
      });
    },
    async softDelete(id) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      if (thread.deletedAt) return thread;
      const now = toIsoString(new Date());
      const updated = {
        ...thread,
        deletedAt: now,
        updatedAt: now,
      };
      threads.set(id, updated);
      return updated;
    },
    async restore(id) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      if (!thread.deletedAt) return thread;
      const updated = { ...thread, deletedAt: null, updatedAt: toIsoString(new Date()) };
      threads.set(id, updated);
      return updated;
    },
  };

  const turnRepo: TurnRepository = {
    async create(input) {
      const turn = defaultTurn(input);
      const existing = turns.get(turn.id);
      if (existing) return existing;
      turns.set(turn.id, turn);
      return turn;
    },
    async findById(id) {
      return turns.get(id) ?? null;
    },
    async listByThread(threadId) {
      return [...turns.values()]
        .filter((t) => t.threadId === threadId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async getLatestByThread(threadId) {
      const threadTurns = await this.listByThread(threadId);
      return threadTurns.at(-1) ?? null;
    },
    async updateStatus(id, input: UpdateTurnStatusInput) {
      const turn = turns.get(id);
      if (!turn) throw new Error(`Turn not found: ${id}`);
      const updated: Turn = {
        ...turn,
        status: input.status,
        finishReason: input.finishReason !== undefined ? input.finishReason : turn.finishReason,
        completedAt:
          input.completedAt !== undefined
            ? input.completedAt === null
              ? null
              : toIsoString(input.completedAt)
            : turn.completedAt,
        error: input.error !== undefined ? input.error : turn.error,
      };
      turns.set(id, updated);
      return updated;
    },
    async recomputeRollups(id) {
      const turn = turns.get(id);
      if (!turn) throw new Error(`Turn not found: ${id}`);
      const responses = [...modelResponses.values()]
        .filter((response) => response.turnId === id)
        .sort((a, b) => a.sequence - b.sequence);
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens: number | null = null;
      let cacheReadTokens: number | null = null;
      let cacheWriteTokens: number | null = null;
      let totalCostUsd = "0";
      let totalMillicredits: string | undefined;
      for (const response of responses) {
        inputTokens += response.inputTokens ?? 0;
        outputTokens += response.outputTokens ?? 0;
        reasoningTokens = addOptionalInteger(reasoningTokens, response.reasoningTokens);
        cacheReadTokens = addOptionalInteger(cacheReadTokens, response.cacheReadTokens);
        cacheWriteTokens = addOptionalInteger(cacheWriteTokens, response.cacheWriteTokens);
        totalCostUsd = addDecimal(totalCostUsd, response.costUsd ?? "0");
        totalMillicredits = addBigIntString(totalMillicredits, response.millicredits);
      }
      const latestResponse = responses.at(-1) ?? null;
      const updated: Turn = {
        ...turn,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalCostUsd,
        totalMillicredits,
        responseCount: responses.length,
        model: latestResponse?.model ?? null,
        provider: latestResponse?.provider ?? null,
        usage: {
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalCostUsd,
          totalMillicredits,
          responseCount: responses.length,
        },
      };
      turns.set(id, updated);
      return updated;
    },
  };

  const blockRepo: BlockRepository = {
    async create(input: CreateBlockInput) {
      const block: Block = {
        id: input.id ?? crypto.randomUUID(),
        turnId: input.turnId,
        responseId: input.responseId ?? null,
        blockType: input.blockType,
        sequence: input.sequence,
        textContent: input.textContent ?? null,
        modelText: input.textContent ?? "",
        content: (input.content ?? null) as Block["content"],
        provider: input.provider ?? null,
        providerData: input.providerData ?? null,
        executionSide: input.executionSide ?? null,
        status: input.status ?? "complete",
        collapsedContent: input.collapsedContent ?? null,
        pruned: false,
        createdAt: toIsoString(new Date()),
      };
      blocks.set(block.id, block);
      return block;
    },
    async upsert(input) {
      const existing = blocks.get(input.id);
      const block: Block = {
        ...existing,
        id: input.id,
        turnId: input.turnId,
        responseId: input.responseId ?? null,
        blockType: input.blockType,
        sequence: input.sequence,
        textContent: input.textContent ?? null,
        modelText: input.textContent ?? "",
        content: (input.content ?? null) as Block["content"],
        provider: input.provider ?? null,
        providerData: input.providerData ?? null,
        executionSide: input.executionSide ?? null,
        status: input.status ?? "complete",
        collapsedContent: input.collapsedContent ?? null,
        pruned: existing?.pruned ?? false,
        createdAt: existing?.createdAt ?? toIsoString(new Date()),
      };
      blocks.set(block.id, block);
      return block;
    },
    async findById(id) {
      return blocks.get(id) ?? null;
    },
    async listByTurn(turnId) {
      return [...blocks.values()]
        .filter((b) => b.turnId === turnId)
        .sort((a, b) => a.sequence - b.sequence);
    },
    async listByThread(threadId: ThreadId) {
      const orderedTurns = [...turns.values()]
        .filter((t) => t.threadId === threadId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const turnOrder = new Map(orderedTurns.map((turn, index) => [turn.id as string, index]));
      return [...blocks.values()]
        .filter((b) => turnOrder.has(b.turnId as string))
        .sort((a, b) => {
          const turnDelta =
            (turnOrder.get(a.turnId as string) ?? 0) - (turnOrder.get(b.turnId as string) ?? 0);
          return turnDelta === 0 ? a.sequence - b.sequence : turnDelta;
        });
    },
    async updatePruned(id, pruned) {
      const block = blocks.get(id);
      if (!block) throw new Error(`Block not found: ${id}`);
      const updated = { ...block, pruned };
      blocks.set(id, updated);
      return updated;
    },
  };

  const modelResponseRepo: ModelResponseRepository = {
    async create(input: CreateModelResponseInput) {
      if (input.id) {
        const existing = modelResponses.get(input.id);
        if (existing) return { row: existing, inserted: false };
      }
      const row: ModelResponse = {
        id: input.id ?? crypto.randomUUID(),
        turnId: input.turnId,
        sequence: input.sequence,
        provider: input.provider,
        model: input.model,
        providerRequestId: input.providerRequestId ?? null,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        reasoningTokens: input.reasoningTokens ?? null,
        cacheReadTokens: input.cacheReadTokens ?? null,
        cacheWriteTokens: input.cacheWriteTokens ?? null,
        costUsd: input.costUsd ?? "0",
        millicredits: input.millicredits ?? null,
        priceSource: input.priceSource,
        pricingSnapshot: input.pricingSnapshot ?? null,
        finishReason: input.finishReason ?? null,
        latencyMs: input.latencyMs ?? null,
        rawUsage: input.rawUsage ?? null,
        createdAt: toIsoString(new Date()),
      };
      modelResponses.set(row.id, row);
      return { row, inserted: true };
    },
    async findById(id) {
      return modelResponses.get(id) ?? null;
    },
    async listByTurn(turnId) {
      return [...modelResponses.values()]
        .filter((r) => r.turnId === turnId)
        .sort((a, b) => a.sequence - b.sequence);
    },
  };

  const threadDocumentRepo: ThreadDocumentRepository = {
    async attach(threadId, documentId, relationship: ThreadDocumentRelationship) {
      const key = `${threadId}:${documentId}`;
      const existing = threadDocuments.get(key);
      const now = toIsoString(new Date());
      const row: ThreadDocument = {
        threadId,
        documentId,
        relationship,
        firstTouchedAt: existing?.firstTouchedAt ?? now,
        lastTouchedAt: now,
      };
      threadDocuments.set(key, row);
      return { ...row };
    },
    async detach(threadId, documentId) {
      threadDocuments.delete(`${threadId}:${documentId}`);
    },
    async listByThread(threadId) {
      return [...threadDocuments.values()]
        .filter((row) => row.threadId === threadId)
        .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
        .map((row) => ({ ...row }));
    },
  };

  const documentTouchRepo: TurnDocumentTouchRepository = {
    async recordTouch(turnId, documentId) {
      const turn = turns.get(turnId);
      if (!turn) throw new Error(`Turn not found: ${turnId}`);
      const key = `${turnId}:${documentId}`;
      const row: TurnDocumentTouch = {
        id: documentTouches.get(key)?.id ?? crypto.randomUUID(),
        turnId,
        documentId,
        threadId: turn.threadId,
        touchedAt: toIsoString(new Date()),
      };
      documentTouches.set(key, row);
      return { ...row };
    },
    async listByThread(threadId, limit) {
      const latestByDocument = new Map<string, TurnDocumentTouch>();
      for (const row of documentTouches.values()) {
        if (row.threadId !== threadId) continue;
        const existing = latestByDocument.get(row.documentId);
        if (!existing || row.touchedAt >= existing.touchedAt) {
          latestByDocument.set(row.documentId, row);
        }
      }
      const rows = [...latestByDocument.values()].sort((a, b) =>
        b.touchedAt.localeCompare(a.touchedAt),
      );
      return (typeof limit === "number" ? rows.slice(0, limit) : rows).map((row) => ({ ...row }));
    },
  };

  return {
    threads: threadRepo,
    turns: turnRepo,
    blocks: blockRepo,
    modelResponses: modelResponseRepo,
    threadDocuments: threadDocumentRepo,
    documentTouches: documentTouchRepo,
    async transaction(operation) {
      const threadsSnapshot = new Map(threads);
      const turnsSnapshot = new Map(turns);
      const blocksSnapshot = new Map(blocks);
      const modelResponsesSnapshot = new Map(modelResponses);
      const threadDocumentsSnapshot = new Map(threadDocuments);
      const documentTouchesSnapshot = new Map(documentTouches);
      try {
        return await operation();
      } catch (error) {
        threads.clear();
        for (const entry of threadsSnapshot) threads.set(...entry);
        turns.clear();
        for (const entry of turnsSnapshot) turns.set(...entry);
        blocks.clear();
        for (const entry of blocksSnapshot) blocks.set(...entry);
        modelResponses.clear();
        for (const entry of modelResponsesSnapshot) modelResponses.set(...entry);
        threadDocuments.clear();
        for (const entry of threadDocumentsSnapshot) threadDocuments.set(...entry);
        documentTouches.clear();
        for (const entry of documentTouchesSnapshot) documentTouches.set(...entry);
        throw error;
      }
    },
    async recordModelResponseUsage(input) {
      const modelResponseResult = await modelResponseRepo.create(input.response);
      if (!modelResponseResult.inserted) {
        const turn = await turnRepo.findById(input.response.turnId);
        if (!turn) throw new Error(`Turn not found: ${input.response.turnId}`);
        return { modelResponse: modelResponseResult.row, turn };
      }
      const turn = await turnRepo.recomputeRollups(input.response.turnId);
      await threadRepo.recomputeCostFromModelResponses(turn.threadId);
      return { modelResponse: modelResponseResult.row, turn };
    },
  };
}

export type InMemoryRepositories = ReturnType<typeof createInMemoryRepositories>;
