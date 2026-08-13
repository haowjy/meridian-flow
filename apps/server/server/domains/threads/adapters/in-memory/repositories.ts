/**
 * In-memory ThreadRepositories: Map-backed thread/turn/block/model-response
 * repositories implementing the full repository ports (incl. the transaction
 * aggregate). For tests/local dev; shares creation semantics via thread-create.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadDocumentRelationship } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type {
  Block,
  HomeChatAttention,
  HomeChatItem,
  ModelResponse,
  Thread,
  Turn,
  TurnUsage,
} from "@meridian/contracts/threads";
import { WorkLifecycleUnavailableError } from "../../../projects/domain/work-lifecycle.js";
import { toIsoString } from "../../domain/contract-serialization.js";
import { normalizeThreadCreate } from "../../domain/thread-create.js";
import { buildDerivedPrimaryThreadRow } from "../../domain/thread-create-derived-primary.js";
import { buildSubagentThreadRow } from "../../domain/thread-create-subagent.js";
import { toThreadListItem } from "../../domain/thread-list-projection.js";
import { uniqueThreadSlug } from "../../domain/thread-slug.js";
import { TurnStartConflictError } from "../../domain/turn-start-transition.js";
import type {
  BlockRepository,
  CreateBlockInput,
  CreateModelResponseInput,
  CreateThreadInput,
  CreateTurnInput,
  DerivedPrimaryThreadFactory,
  HomeChatFeedRepository,
  InternalThreadRepositories,
  ModelResponseRepository,
  SubagentThreadFactory,
  ThreadDocument,
  ThreadDocumentRepository,
  ThreadRepository,
  ThreadUserStateRepository,
  ThreadWorksRepository,
  TurnDocumentTouch,
  TurnDocumentTouchRepository,
  TurnRepository,
  UpdateSpawnLifecycleInput,
  UpdateTurnStatusInput,
} from "../../ports/repositories.js";
import { ThreadWorkProjectMismatchError } from "../../ports/repositories.js";

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
    projectId: input.projectId,
    workId: null,
    userId: input.userId,
    kind: normalized.kind,
    status: "idle",
    title: normalized.title === "" ? null : normalized.title,
    slug: null,
    systemPrompt: normalized.systemPrompt,
    composedSystemPrompt: null,
    bakedSkillSlugs: null,
    workingState: input.workingState ?? null,
    currentAgent: normalized.currentAgent,
    nextSeq: "0",
    activeLeafTurnId: null,
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
    writeMode: input.writeMode ?? null,
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
    metadata: input.metadata ?? null,
    createdAt: now,
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

interface ProjectVisibilityRepository {
  findById(id: string): Promise<{ deletedAt: string | null } | null>;
}

interface WorkProjectionRepository {
  findById(
    id: string,
  ): Promise<{ id: string; name: string; projectId: string; deletedAt: string | null } | null>;
}

export interface InMemoryRepositoriesOptions {
  projects?: ProjectVisibilityRepository;
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
  const threadWorks = new Map<string, { threadId: ThreadId; workId: WorkId; isPrimary: boolean }>();
  const workContextDeliveries = new Set<string>();
  const userStateByThreadUser = new Map<
    string,
    { isFavorite: boolean; manuallyUnread: boolean; lastOpenedAt: string | null }
  >();
  const transactionContext = new AsyncLocalStorage<boolean>();
  let transactionTail: Promise<void> = Promise.resolve();

  function receivesWorkContextUpdate(thread: Thread | undefined): thread is Thread {
    return !!thread && thread.status !== "archived";
  }

  function nextSlug(projectId: string, title: string | null | undefined): string | null {
    return uniqueThreadSlug(
      title,
      [...threads.values()]
        .filter((thread) => thread.projectId === projectId && !thread.deletedAt)
        .flatMap((thread) => (thread.slug ? [thread.slug] : [])),
    );
  }

  function openedKey(threadId: ThreadId, userId: string): string {
    return `${threadId}:${userId}`;
  }

  function membershipKey(threadId: ThreadId, workId: WorkId): string {
    return `${threadId}:${workId}`;
  }

  function primaryWorkIdForThread(threadId: ThreadId): WorkId | null {
    for (const row of threadWorks.values()) {
      if (row.threadId === threadId && row.isPrimary) return row.workId;
    }
    return null;
  }

  function projectThread(thread: Thread): Thread {
    return { ...thread, workId: primaryWorkIdForThread(thread.id as ThreadId) };
  }

  async function threadInActiveProject(thread: Thread): Promise<boolean> {
    if (!options.projects) return true;
    const project = await options.projects.findById(thread.projectId);
    return Boolean(project && !project.deletedAt);
  }

  async function toListItem(thread: Thread) {
    const projected = projectThread(thread);
    const work =
      projected.workId && options.works ? await options.works.findById(projected.workId) : null;
    const threadTurns = [...turns.values()].filter((turn) => turn.threadId === thread.id);
    const latestTurn = projected.activeLeafTurnId
      ? (turns.get(projected.activeLeafTurnId) ?? null)
      : null;
    const runningTurn = [...threadTurns]
      .reverse()
      .find(
        (turn) =>
          turn.role === "assistant" && (turn.status === "pending" || turn.status === "streaming"),
      );

    return toThreadListItem({
      thread: projected,
      workTitle: work && !work.deletedAt ? work.name : null,
      lastTurnRole: latestTurn?.role ?? null,
      lastTurnStatus: latestTurn?.status ?? null,
      lastTurnAt: latestTurn ? (latestTurn.completedAt ?? latestTurn.createdAt) : null,
      lastOpenedAt:
        userStateByThreadUser.get(openedKey(thread.id, thread.userId))?.lastOpenedAt ?? null,
      runningTurnId: runningTurn?.id ?? null,
    });
  }

  const threadRepo: ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory = {
    async create(input) {
      const thread = {
        ...defaultThread(input),
        slug: nextSlug(input.projectId, input.title),
      };
      threads.set(thread.id, thread);
      return projectThread(thread);
    },
    async createSubagent(input) {
      const thread = {
        ...buildSubagentThreadRow(input),
        slug: nextSlug(input.projectId, input.title),
      };
      threads.set(thread.id, { ...thread, workId: null });
      return projectThread(thread);
    },
    async createDerivedPrimary(input) {
      const thread = {
        ...buildDerivedPrimaryThreadRow(input),
        slug: nextSlug(input.projectId, input.title),
      };
      threads.set(thread.id, { ...thread, workId: null });
      return projectThread(thread);
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
      return projectThread(updated);
    },
    async findById(id) {
      const thread = threads.get(id);
      if (!thread || thread.deletedAt || !(await threadInActiveProject(thread))) return null;
      return projectThread(thread);
    },
    async findProjectIdByIdIncludingDeleted(id) {
      return threads.get(id)?.projectId ?? null;
    },
    async listByUser(userId) {
      const visible: Thread[] = [];
      for (const thread of threads.values()) {
        if (
          thread.userId === userId &&
          !thread.deletedAt &&
          (await threadInActiveProject(thread))
        ) {
          visible.push(projectThread(thread));
        }
      }
      return visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async listByProject(projectId) {
      const visible: Thread[] = [];
      for (const thread of threads.values()) {
        if (
          thread.projectId === projectId &&
          !thread.deletedAt &&
          (await threadInActiveProject(thread))
        ) {
          visible.push(projectThread(thread));
        }
      }
      const ordered = visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return Promise.all(ordered.map(toListItem));
    },
    async listByWork(projectId, workId) {
      const visible: Thread[] = [];
      for (const thread of threads.values()) {
        if (
          thread.projectId === projectId &&
          [...threadWorks.values()].some(
            (row) => row.threadId === thread.id && row.workId === workId,
          ) &&
          !thread.deletedAt &&
          (await threadInActiveProject(thread))
        ) {
          visible.push(projectThread(thread));
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
      return projectThread(updated);
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
      return projectThread(updated);
    },
    async bakeComposedSystemPrompt(id, input) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      if (thread.bakedSkillSlugs !== null) {
        return projectThread(thread);
      }
      if (
        input.expectedCurrentAgent !== undefined &&
        thread.currentAgent !== input.expectedCurrentAgent
      ) {
        return projectThread(thread);
      }
      const updated = {
        ...thread,
        composedSystemPrompt: input.composedSystemPrompt,
        bakedSkillSlugs: input.bakedSkillSlugs,
        systemPrompt: null,
        updatedAt: toIsoString(new Date()),
      };
      threads.set(id, updated);
      return projectThread(updated);
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
      if (thread.deletedAt) return projectThread(thread);
      const now = toIsoString(new Date());
      const updated = {
        ...thread,
        deletedAt: now,
        updatedAt: now,
      };
      threads.set(id, updated);
      return projectThread(updated);
    },
    async restore(id) {
      const thread = threads.get(id);
      if (!thread) throw new Error(`Thread not found: ${id}`);
      if (!thread.deletedAt) return projectThread(thread);
      const updated = { ...thread, deletedAt: null, updatedAt: toIsoString(new Date()) };
      threads.set(id, updated);
      return projectThread(updated);
    },
  };

  const threadWorksRepo: ThreadWorksRepository = {
    async addMembership(threadId, workId, isPrimary) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error("Thread membership requires an existing thread");
      if (options.works) {
        const work = await options.works.findById(workId);
        if (!work || work.deletedAt || work.id !== workId) {
          throw new WorkLifecycleUnavailableError(workId, !work ? "missing" : "deleted");
        }
        if (work.projectId !== thread.projectId) {
          throw new ThreadWorkProjectMismatchError(workId);
        }
      }
      const snapshot = new Map(threadWorks);
      try {
        if (isPrimary) {
          for (const [key, row] of threadWorks) {
            if (row.threadId === threadId && row.isPrimary) {
              threadWorks.set(key, { ...row, isPrimary: false });
            }
          }
        }
        threadWorks.set(membershipKey(threadId, workId), { threadId, workId, isPrimary });
      } catch (error) {
        threadWorks.clear();
        for (const entry of snapshot) threadWorks.set(...entry);
        throw error;
      }
    },
    async findPrimary(threadId) {
      const workId = primaryWorkIdForThread(threadId);
      return workId ? { workId } : null;
    },
    async lockPrimary(threadId) {
      const workId = primaryWorkIdForThread(threadId);
      return workId ? { workId } : null;
    },
    async rebindPrimary(threadId, workId) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error("Thread membership requires an existing thread");
      if (options.works) {
        const work = await options.works.findById(workId);
        if (!work || work.deletedAt) {
          throw new WorkLifecycleUnavailableError(workId, !work ? "missing" : "deleted");
        }
        if (work.projectId !== thread.projectId) throw new ThreadWorkProjectMismatchError(workId);
      }
      const previousWorkId = primaryWorkIdForThread(threadId);
      if (previousWorkId === workId) return { previousWorkId, changed: false };
      if (previousWorkId) threadWorks.delete(membershipKey(threadId, previousWorkId));
      threadWorks.delete(membershipKey(threadId, workId));
      threadWorks.set(membershipKey(threadId, workId), { threadId, workId, isPrimary: true });
      return { previousWorkId, changed: true };
    },
    async listByThread(threadId) {
      return [...threadWorks.values()]
        .filter((row) => row.threadId === threadId)
        .map((row) => ({ workId: row.workId, isPrimary: row.isPrimary }));
    },
  };

  const turnRepo: TurnRepository = {
    async create(input) {
      const turn = defaultTurn(input);
      const existing = turns.get(turn.id);
      if (existing) return existing;
      if (
        !turn.prevTurnId &&
        [...turns.values()].some(
          (candidate) => candidate.threadId === turn.threadId && !candidate.prevTurnId,
        )
      ) {
        throw new TurnStartConflictError(turn.threadId, "already_exists");
      }
      turns.set(turn.id, turn);
      const thread = threads.get(turn.threadId);
      if (thread) {
        threads.set(turn.threadId, { ...thread, activeLeafTurnId: turn.id });
      }
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
    async listThreadIdsByDocument(documentId) {
      return [...threadDocuments.values()]
        .filter((row) => row.documentId === documentId)
        .map(({ threadId }) => threadId);
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
    async listThreadIdsByDocument(documentId) {
      return [
        ...new Set(
          [...documentTouches.values()]
            .filter((row) => row.documentId === documentId)
            .map(({ threadId }) => threadId),
        ),
      ];
    },
  };

  function conversationalHead(thread: Thread): Turn | null {
    let turn = thread.activeLeafTurnId ? turns.get(thread.activeLeafTurnId) : undefined;
    const visited = new Set<string>();
    while (turn && !visited.has(turn.id)) {
      visited.add(turn.id);
      const metadata = turn.metadata as Record<string, unknown> | null;
      const hiddenWorkUpdate =
        turn.role === "user" &&
        metadata?.kind === "system_update" &&
        metadata.section === "work_context";
      const visibleSystem =
        turn.role === "system" &&
        [...blocks.values()].some(
          (block) => block.turnId === turn?.id && block.blockType === "custom",
        );
      if (
        turn.role === "assistant" ||
        (turn.role === "user" && !hiddenWorkUpdate) ||
        visibleSystem
      ) {
        return turn;
      }
      turn = turn.parentTurnId ? turns.get(turn.parentTurnId) : undefined;
    }
    return null;
  }

  function exactTimestamp(value: string): string {
    return value.replace(/\.(\d{3})Z$/, ".$1000Z");
  }

  function effectiveAttention(
    thread: Thread,
    head: Turn | null,
    userId: string,
  ): HomeChatAttention {
    const state = userStateByThreadUser.get(openedKey(thread.id, userId));
    const activity = head ? (head.completedAt ?? head.createdAt) : thread.createdAt;
    if (head?.role === "assistant" && head.status === "waiting_interrupt") return "actionRequired";
    if (state?.manuallyUnread) return "unread";
    if (
      thread.status === "idle" &&
      head?.role === "assistant" &&
      head.status === "complete" &&
      (!state?.lastOpenedAt || activity > state.lastOpenedAt)
    ) {
      return "unread";
    }
    return "none";
  }

  async function homeItem(thread: Thread, userId: string): Promise<HomeChatItem> {
    const head = conversationalHead(thread);
    const workId = primaryWorkIdForThread(thread.id as ThreadId);
    const work = workId && options.works ? await options.works.findById(workId) : null;
    const preview = head
      ? [...blocks.values()]
          .filter(
            (block) => block.turnId === head.id && block.blockType === "text" && !block.pruned,
          )
          .sort((a, b) => a.sequence - b.sequence)
          .map((block) => block.modelText ?? "")
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim()
      : "";
    const state = userStateByThreadUser.get(openedKey(thread.id, userId));
    return {
      id: thread.id,
      title: thread.title ?? "",
      work: workId && work && !work.deletedAt ? { id: workId, title: work.name } : null,
      lastMessagePreview: preview ? Array.from(preview).slice(0, 240).join("") : null,
      lastActivityAt: exactTimestamp(
        head ? (head.completedAt ?? head.createdAt) : thread.createdAt,
      ),
      attention: effectiveAttention(thread, head, userId),
      isFavorite: state?.isFavorite ?? false,
    };
  }

  const homeFeed: HomeChatFeedRepository = {
    async queryPage(input) {
      const eligible: HomeChatItem[] = [];
      for (const thread of threads.values()) {
        if (
          thread.projectId === input.projectId &&
          !thread.deletedAt &&
          thread.status !== "archived" &&
          (await threadInActiveProject(thread))
        ) {
          eligible.push(await homeItem(thread, input.userId));
        }
      }
      eligible.sort(
        (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id),
      );
      const continueChat = eligible[0] ?? null;
      const favorites = input.includeFeatured
        ? eligible.filter((item) => item.id !== continueChat?.id && item.isFavorite)
        : [];
      const after = input.after;
      const recent = eligible
        .filter((item) => item.id !== continueChat?.id && !item.isFavorite)
        .filter(
          (item) =>
            !after ||
            item.lastActivityAt < after.lastActivityAt ||
            (item.lastActivityAt === after.lastActivityAt && item.id < after.threadId),
        )
        .slice(0, input.recentLimit);
      return {
        continueChat: input.includeFeatured ? continueChat : null,
        favorites,
        recent,
      };
    },
  };

  const threadUserState: ThreadUserStateRepository = {
    async get(threadId, userId) {
      return (
        userStateByThreadUser.get(openedKey(threadId, userId)) ?? {
          isFavorite: false,
          manuallyUnread: false,
          lastOpenedAt: null,
        }
      );
    },
    async effectiveAttention(threadId, userId) {
      const thread = threads.get(threadId);
      return thread ? effectiveAttention(thread, conversationalHead(thread), userId) : "none";
    },
    async update(input) {
      const key = openedKey(input.threadId, input.userId);
      const current = await this.get(input.threadId, input.userId);
      const next = {
        isFavorite: input.isFavorite ?? current.isFavorite,
        manuallyUnread: input.isUnread ?? current.manuallyUnread,
        lastOpenedAt: input.isUnread === false ? new Date().toISOString() : current.lastOpenedAt,
      };
      userStateByThreadUser.set(key, next);
      return {
        threadId: input.threadId,
        ...next,
        attention: await this.effectiveAttention(input.threadId, input.userId),
      };
    },
  };

  return {
    threads: threadRepo,
    homeFeed,
    threadUserState,
    threadWorks: threadWorksRepo,
    turns: turnRepo,
    blocks: blockRepo,
    modelResponses: modelResponseRepo,
    threadDocuments: threadDocumentRepo,
    documentTouches: documentTouchRepo,
    workContextDeliveries: {
      async enqueueThread(threadId) {
        if (receivesWorkContextUpdate(threads.get(threadId))) workContextDeliveries.add(threadId);
        return workContextDeliveries.has(threadId) ? [threadId] : [];
      },
      async enqueueProject(projectId: ProjectId) {
        for (const thread of threads.values()) {
          if (thread.projectId === projectId && receivesWorkContextUpdate(thread)) {
            workContextDeliveries.add(thread.id);
          }
        }
        return [...workContextDeliveries].filter(
          (threadId) => threads.get(threadId)?.projectId === projectId,
        ) as ThreadId[];
      },
      async listPendingThreadIds() {
        return [...workContextDeliveries].filter((threadId) =>
          receivesWorkContextUpdate(threads.get(threadId)),
        ) as ThreadId[];
      },
      async isPending(threadId) {
        return workContextDeliveries.has(threadId);
      },
      async lockPending(threadId) {
        return workContextDeliveries.has(threadId);
      },
      async acknowledge(threadId) {
        workContextDeliveries.delete(threadId);
      },
    },
    async transaction(operation) {
      if (transactionContext.getStore()) return operation();

      const previous = transactionTail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      transactionTail = previous.then(
        () => gate,
        () => gate,
      );
      await previous.catch(() => undefined);
      try {
        return await transactionContext.run(true, async () => {
          const threadsSnapshot = new Map(threads);
          const turnsSnapshot = new Map(turns);
          const blocksSnapshot = new Map(blocks);
          const modelResponsesSnapshot = new Map(modelResponses);
          const threadDocumentsSnapshot = new Map(threadDocuments);
          const documentTouchesSnapshot = new Map(documentTouches);
          const threadWorksSnapshot = new Map(threadWorks);
          const userStateSnapshot = new Map(userStateByThreadUser);
          const workContextDeliveriesSnapshot = new Set(workContextDeliveries);
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
            threadWorks.clear();
            for (const entry of threadWorksSnapshot) threadWorks.set(...entry);
            userStateByThreadUser.clear();
            for (const entry of userStateSnapshot) userStateByThreadUser.set(...entry);
            workContextDeliveries.clear();
            for (const threadId of workContextDeliveriesSnapshot) {
              workContextDeliveries.add(threadId);
            }
            throw error;
          }
        });
      } finally {
        release();
      }
    },
    async runTurnStartTransition(threadId, expectedActiveLeafTurnId, operation) {
      return this.transaction(async () => {
        if (threads.get(threadId)?.activeLeafTurnId !== expectedActiveLeafTurnId) {
          throw new TurnStartConflictError(threadId, "already_running");
        }
        return operation();
      });
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
