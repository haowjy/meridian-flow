/**
 * Child report delivery: the durable obligation to surface a background child's
 * terminal report to its parent, written atomically with the child's terminal
 * lifecycle and driven to exactly-once delivery by the flush/sweep.
 *
 * Two deterministic keys make replay a no-op without in-process state: the
 * writer-facing card uses the report id as its block id, and the parent
 * continuation is admitted with `child-report:<reportId>:<epoch>` as its
 * submission id. The system-turn container id is stored on the obligation so a
 * re-drive reuses it instead of orphaning an empty turn.
 */
import { buildHelperResultComponentContent } from "@meridian/contracts/components";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import type { OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type {
  ChildReportDeliveryObligation,
  EventJournalWriter,
  ThreadRepositories,
} from "../../threads/index.js";
import type { HostTurnAdmission } from "../admission/user-turn-admission.js";
import { contentForBlockInput } from "../loop/block-helpers.js";
import { persistAndAppendEvents } from "../loop/persistence.js";
import { spawnHelperCardProps } from "./spawn-output.js";

export interface ChildReportEnqueue {
  reportId: TurnId;
  parentThreadId: ThreadId;
  childThreadId: ThreadId;
  agentSlug: string;
  description?: string;
  result: SpawnResult;
  systemTurnId?: TurnId;
}

export interface ChildReportDelivery {
  enqueue(input: ChildReportEnqueue): Promise<void>;
  flush(parentThreadId: ThreadId): Promise<void>;
  sweep(): Promise<void>;
}

export interface ChildReportDeliveryDeps {
  repos: Pick<
    ThreadRepositories,
    | "blocks"
    | "modelResponses"
    | "runTurnStartTransition"
    | "threads"
    | "turns"
    | "transaction"
    | "childReportDeliveries"
  >;
  eventWriter: EventJournalWriter;
  admission: HostTurnAdmission;
  isThreadRunning(threadId: ThreadId): boolean;
  /** Schedule a non-blocking wake after the caller's business transaction commits. */
  schedulePostCommit(task: () => Promise<void>): void;
}

/** Pinned continuation payload; must stay byte-stable across restarts. */
export const CHILD_REPORT_CONTINUATION_TEXT =
  "A background subagent has reported. Continue from its report.";

const CHILD_REPORT_SECTION = "child_report";

/** A rejected attempt committed no turn, so advancing the epoch stays exactly-once. */
const MAX_EPOCH_ATTEMPTS = 3;

function createLocalSystemTurn(input: { threadId: ThreadId; parentTurnId: TurnId | null }): Turn {
  const now = toIsoString(new Date());
  return {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    prevTurnId: input.parentTurnId,
    parentTurnId: input.parentTurnId,
    role: "system",
    writeMode: null,
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

export function createChildReportDelivery(deps: ChildReportDeliveryDeps): ChildReportDelivery {
  const flushChains = new Map<string, Promise<void>>();

  async function ensureCard(obligation: ChildReportDeliveryObligation): Promise<void> {
    const leaf = await deps.repos.turns.getLatestByThread(obligation.parentThreadId);
    const parentTurnId = leaf?.id ?? null;
    const cardProps = spawnHelperCardProps({
      agent: obligation.agentSlug,
      description: obligation.description ?? undefined,
      parentTurnId: (parentTurnId ?? obligation.reportId) as string,
      childThreadId: obligation.childThreadId,
      output: obligation.result,
    });
    const card = (turnId: TurnId) =>
      contentForBlockInput({
        id: obligation.reportId,
        turnId,
        blockType: "custom",
        sequence: 0,
        content: buildHelperResultComponentContent(cardProps),
        status: "complete",
      });

    const existingContainer =
      obligation.systemTurnId && (await deps.repos.turns.findById(obligation.systemTurnId));
    if (existingContainer) {
      await persistAndAppendEvents(deps, obligation.parentThreadId, async () => ({
        result: null,
        events: [
          { type: "block.upserted", block: card(obligation.systemTurnId as TurnId) },
        ] as OrchestratorEvent[],
      }));
      return;
    }

    const systemTurn = createLocalSystemTurn({
      threadId: obligation.parentThreadId,
      parentTurnId: parentTurnId as TurnId | null,
    });
    await persistAndAppendEvents(deps, obligation.parentThreadId, async () => {
      // Atomic with the container it names, so a re-drive reuses the same turn.
      await deps.repos.childReportDeliveries.setSystemTurnId(
        obligation.reportId,
        systemTurn.id as TurnId,
      );
      return {
        result: null,
        events: [
          { type: "turn.created", turn: systemTurn },
          { type: "block.upserted", block: card(systemTurn.id as TurnId) },
        ] as OrchestratorEvent[],
      };
    });
  }

  async function deliverOne(obligation: ChildReportDeliveryObligation): Promise<void> {
    const parent = await deps.repos.threads.findById(obligation.parentThreadId);
    if (!parent) {
      await deps.repos.childReportDeliveries.acknowledge(obligation.reportId);
      return;
    }

    let epoch = obligation.submissionEpoch;
    for (let attempt = 0; attempt < MAX_EPOCH_ATTEMPTS; attempt += 1) {
      const submissionId = `child-report:${obligation.reportId}:${epoch}`;
      const lookup = await deps.admission.lookup({
        actorUserId: parent.userId,
        threadId: obligation.parentThreadId,
        submissionId,
      });

      if (lookup.kind === "already-accepted") {
        await deps.repos.childReportDeliveries.acknowledge(obligation.reportId);
        return;
      }
      if (lookup.kind === "pending") return;
      if (lookup.kind === "rejected" || lookup.kind === "retired") {
        await deps.repos.childReportDeliveries.advanceEpoch(obligation.reportId);
        epoch += 1;
        continue;
      }

      await ensureCard(obligation);
      const admitted = await deps.admission.admit({
        actorUserId: parent.userId,
        threadId: obligation.parentThreadId,
        submissionId,
        text: CHILD_REPORT_CONTINUATION_TEXT,
        userTurnMetadata: { kind: "system_update", section: CHILD_REPORT_SECTION },
      });
      if (admitted.kind === "accepted" || admitted.kind === "already-accepted") {
        await deps.repos.childReportDeliveries.acknowledge(obligation.reportId);
        return;
      }
      // A pending or rejected continuation leaves the obligation for the next
      // sweep; a rejection advances the epoch there, not twice in one pass.
      return;
    }
  }

  async function flushUnlocked(parentThreadId: ThreadId): Promise<void> {
    if (deps.isThreadRunning(parentThreadId)) return;
    const obligations = await deps.repos.childReportDeliveries.listPendingByParent(parentThreadId);
    for (const obligation of obligations) {
      await deliverOne(obligation);
    }
  }

  async function flush(parentThreadId: ThreadId): Promise<void> {
    const key = parentThreadId as string;
    const previous = flushChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => flushUnlocked(parentThreadId));
    const settled = next.catch(() => undefined);
    flushChains.set(key, settled);
    try {
      await next;
    } finally {
      if (flushChains.get(key) === settled) flushChains.delete(key);
    }
  }

  return {
    async enqueue(input) {
      await deps.repos.childReportDeliveries.enqueue({
        reportId: input.reportId,
        parentThreadId: input.parentThreadId,
        childThreadId: input.childThreadId,
        agentSlug: input.agentSlug,
        description: input.description ?? null,
        result: input.result,
        systemTurnId: input.systemTurnId ?? null,
      });
      deps.schedulePostCommit(() => flush(input.parentThreadId));
    },

    flush,

    async sweep() {
      const parentThreadIds = await deps.repos.childReportDeliveries.listPendingParentThreadIds();
      await Promise.all(parentThreadIds.map(flush));
    },
  };
}
