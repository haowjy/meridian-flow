/** Owns handoff seed launch, Stop, Retry, crash recovery, accounting, and wake-up. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { Thread, Turn } from "@meridian/contracts/threads";
import {
  HandoffSeedMetadataCodec,
  handoffSeedMetadata,
  type ThreadRepositories,
  type HandoffFailureOutcome,
} from "../../threads/index.js";
import type { BillingUsagePolicy } from "../../billing/index.js";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/ports/event-journal.js";
import { historyReadableAt } from "../loop/history-tool-availability.js";
import { createLocalTurn } from "../loop/local-turn.js";
import { persistAndAppendEvents, persistAndAppendTurnStartEvents, type PersistenceDeps } from "../loop/persistence.js";
import { settleSummaryResponses } from "../loop/settle-summary-responses.js";
import { createTurnAccounting } from "../loop/turn-accounting.js";
import type { RunClaim, RunStarter } from "../loop/ports.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import type { HandoffBriefClaim } from "../ports/handoff-brief-claim.js";
import type { HandoffBriefStopper } from "../ports/handoff-briefs.js";
import { resolveMaxSpawnDepth } from "../spawn/tree-budget.js";
import { completeHandoffSeed, handoffBriefFailedCopy, handoffBriefUnavailableCopy, handoffSeedBlock } from "./seed.js";

const MAX_LAUNCHES = 3;
const RECOVERY_PAGE_SIZE = 100;
const REMOTE_STOP_POLL_MS = 5_000;

export type HandoffRetryErrorCode =
  | "not_a_handoff_retry"
  | "handoff_retry_unavailable"
  | "seed_id_conflict";

export class HandoffRetryError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: HandoffRetryErrorCode) {
    super(code);
  }
}

type BriefGeneration = (input: {
  destination: Thread;
  seed: Turn;
  signal: AbortSignal;
}) => Promise<{ outcome: SummaryOutcome; failure?: HandoffFailureOutcome }>;

type HandoffBriefServiceDeps = {
  repos: ThreadRepositories;
  eventWriter: EventJournalWriter;
  eventSink: EventSink;
  threadLock: ThreadLock;
  claim: HandoffBriefClaim;
  runClaim: Pick<RunClaim, "read">;
  runStarter: RunStarter;
  billingUsage: Pick<BillingUsagePolicy, "canStartTurn">;
  toolRegistry?: Pick<import("../tools/types.js").ToolRegistry, "getRegistration">;
  generate: BriefGeneration;
  publishStatus(threadId: ThreadId): Promise<void>;
  schedulePostCommit(task: () => Promise<void>): void;
};

type LiveBrief = { controller: AbortController; threadId: ThreadId };

export interface HandoffBriefs extends HandoffBriefStopper {
  launch(seedTurnId: TurnId): Promise<void>;
  launchAfterCommit(input: { threadId: ThreadId; seedTurnId: TurnId }): void;
  retry(input: { threadId: ThreadId; seedId: TurnId }): Promise<{ turn: Turn; created: boolean }>;
  sweep(limit?: number): Promise<number>;
}

export function createHandoffBriefs(deps: HandoffBriefServiceDeps): HandoffBriefs {
  const persistence: PersistenceDeps = {
    repos: deps.repos,
    eventWriter: deps.eventWriter,
  };
  const live = new Map<TurnId, LiveBrief>();
  const accounting = createTurnAccounting({ billingUsage: deps.billingUsage as BillingUsagePolicy });
  const treeBudget = createDefaultTreeBudget({ maxDepth: resolveMaxSpawnDepth(process.env) });

  function publishStatus(threadId: ThreadId) {
    deps.schedulePostCommit(async () => {
      try {
        await deps.publishStatus(threadId);
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.handoff",
          name: "status.publish_failed",
          correlation: { threadId },
          payload: unknownToEventPayload(error),
        });
      }
    });
  }

  function wake(threadId: ThreadId) {
    deps.schedulePostCommit(async () => {
      try {
        await deps.runStarter.start(threadId);
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.handoff",
          name: "wake.failed",
          correlation: { threadId },
          payload: unknownToEventPayload(error),
        });
      }
    });
  }

  async function currentSeed(seedTurnId: TurnId): Promise<{ seed: Turn; thread: Thread } | null> {
    const seed = await deps.repos.turns.findById(seedTurnId);
    if (!seed || seed.role !== "system" || !HandoffSeedMetadataCodec.safeParse(seed.metadata).success)
      return null;
    const thread = await deps.repos.threads.findById(seed.threadId);
    return thread ? { seed, thread } : null;
  }

  async function settleResponses(thread: Thread, rows: readonly SummaryOutcome["modelResponses"][number][]) {
    await settleSummaryResponses({ deps: persistence, thread, rows, accounting, treeBudget });
  }

  async function terminalSeed(
    thread: Thread,
    seed: Turn,
    outcome: SummaryOutcome,
    failure?: HandoffFailureOutcome,
    cause?: string,
  ) {
    const success = outcome.kind === "complete";
    const cancelled = outcome.kind === "cancelled";
    const error = success || cancelled ? null : handoffBriefFailedCopy;
    const completed: Turn = {
      ...seed,
      status: success ? "complete" : cancelled ? "cancelled" : "error",
      finishReason: success ? "end_turn" : cancelled ? null : "error",
      error,
      completedAt: new Date().toISOString(),
    };
    const readable = await historyReadableAt({ repos: deps.repos, toolRegistry: deps.toolRegistry }, seed);
    const block = handoffSeedBlock(seed, success ? outcome : undefined, readable);
    return completeHandoffSeed(persistence, completed, block, {
      summarizer: outcome.summarizer,
      ...(failure ? { failure } : {}),
      ...(cause ? { cause } : {}),
    });
  }

  async function finish(
    threadId: ThreadId,
    seedTurnId: TurnId,
    generation: { outcome: SummaryOutcome; failure?: HandoffFailureOutcome },
    options: { retrySettlement?: boolean; cause?: string } = {},
  ): Promise<void> {
    const { outcome, failure } = generation;
    const rows = outcome.modelResponses;
    const apply = async (finalGeneration = generation, finalCause = options.cause) =>
      deps.threadLock.withThreadLock(threadId, async () =>
        deps.repos.transaction(async () => {
          const saved = await deps.repos.turns.findById(seedTurnId);
          const thread = await deps.repos.threads.findById(threadId);
          if (!saved || !thread) throw new Error("Handoff seed or destination disappeared");
          if (saved.status !== "pending") {
            await settleResponses(thread, rows);
            return false;
          }
          if (finalGeneration.outcome.kind === "cancelled") {
            const metadata = HandoffSeedMetadataCodec.parse(saved.metadata);
            await deps.repos.turns.updateStatus(saved.id, {
              status: "pending",
              metadata: { ...metadata, launches: Math.max(0, metadata.launches - 1) },
            });
            await settleResponses(thread, rows);
            return false;
          }
          await terminalSeed(thread, saved, finalGeneration.outcome, finalGeneration.failure, finalCause);
          await settleResponses(thread, rows);
          return true;
        }),
      );

    try {
      const settled = await apply();
      if (settled) {
        publishStatus(threadId);
        wake(threadId);
      }
    } catch (error) {
      if (options.retrySettlement !== false) {
        try {
          const settled = await apply();
          if (settled) {
            publishStatus(threadId);
            wake(threadId);
          }
          return;
        } catch (retryError) {
          if (outcome.kind === "cancelled") throw retryError;
          emitEvent(deps.eventSink, {
            level: "error",
            source: "runtime.handoff",
            name: "settlement.retry_failed",
            correlation: { threadId, turnId: seedTurnId },
            payload: unknownToEventPayload(retryError),
          });
          const fallback: SummaryOutcome = {
            kind: "failed",
            error: retryError,
            modelResponses: rows,
            summarizer: outcome.summarizer,
          };
          try {
            const settled = await apply(
              {
                outcome: fallback,
                failure: { reason: "handoff_brief_failed", phase: "settle" },
              },
              error instanceof Error ? error.message : String(error),
            );
            if (settled) {
              publishStatus(threadId);
              wake(threadId);
            }
          } catch (finalError) {
            emitEvent(deps.eventSink, {
              level: "error",
              source: "runtime.handoff",
              name: "settlement.failed",
              correlation: { threadId, turnId: seedTurnId },
              payload: unknownToEventPayload(finalError),
            });
          }
          return;
        }
      }
      throw error;
    }
  }

  async function markLaunch(seedTurnId: TurnId, threadId: ThreadId) {
    return deps.threadLock.withThreadLock(threadId, async () => {
      const saved = await deps.repos.turns.findById(seedTurnId);
      const thread = await deps.repos.threads.findById(threadId);
      if (!saved || saved.status !== "pending" || !thread) return null;
      const metadata = HandoffSeedMetadataCodec.parse(saved.metadata);
      if (metadata.launches >= MAX_LAUNCHES) {
        const outcome: SummaryOutcome = {
          kind: "failed",
          error: new Error("Handoff brief exceeded its recovery launch limit"),
          modelResponses: [],
          summarizer: { path: "rolling", segments: 0 },
        };
        return { thread, seed: saved, limitReached: true as const, outcome };
      }
      const seed = await deps.repos.turns.updateStatus(seedTurnId, {
        status: "pending",
        metadata: { ...metadata, launches: metadata.launches + 1 },
      });
      return { thread, seed, limitReached: false as const };
    });
  }

  async function launch(seedTurnId: TurnId): Promise<void> {
    const initial = await currentSeed(seedTurnId);
    if (!initial) return;
    const claim = await deps.claim.tryAcquire(seedTurnId);
    if (!claim) return;
    const controller = new AbortController();
    const holder: LiveBrief = { controller, threadId: initial.thread.id };
    live.set(seedTurnId, holder);
    const removeLost = claim.onLost(() => controller.abort());
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      const start = await markLaunch(seedTurnId, initial.thread.id);
      if (!start) return;
      if (start.limitReached) {
        const failure = { reason: "interrupted", phase: "recovery" } as const;
        await finish(initial.thread.id, seedTurnId, { outcome: start.outcome, failure });
        return;
      }
      publishStatus(start.thread.id);
      if (!(await deps.billingUsage.canStartTurn(start.thread.userId))) {
        await finish(initial.thread.id, seedTurnId, {
          outcome: {
            kind: "failed",
            error: new Error("Credits exhausted"),
            modelResponses: [],
            summarizer: { path: "rolling", segments: 0 },
          },
          failure: { reason: "credits_exhausted", phase: "launch" },
        });
        return;
      }
      poll = setInterval(() => {
        void deps.repos.turns.findById(seedTurnId).then((seed) => {
          if (!seed || seed.status !== "pending") controller.abort();
        }).catch((error) => {
          emitEvent(deps.eventSink, {
            level: "warn",
            source: "runtime.handoff",
            name: "stop_poll.failed",
            correlation: { threadId: start.thread.id, turnId: seedTurnId },
            payload: unknownToEventPayload(error),
          });
        });
      }, REMOTE_STOP_POLL_MS);
      poll.unref();
      let generated: Awaited<ReturnType<BriefGeneration>>;
      try {
        generated = await deps.generate({ destination: start.thread, seed: start.seed, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          generated = {
            outcome: {
              kind: "cancelled",
              modelResponses: [],
              summarizer: { path: "rolling", segments: 0 },
            },
          };
        } else {
          generated = {
            outcome: {
              kind: "failed",
              error,
              modelResponses: [],
              summarizer: { path: "rolling", segments: 0 },
            },
            failure: { reason: "handoff_brief_failed", phase: "source_prepare" },
          };
        }
      }
      await finish(start.thread.id, seedTurnId, generated);
    } finally {
      if (poll) clearInterval(poll);
      removeLost();
      if (live.get(seedTurnId) === holder) live.delete(seedTurnId);
      await claim.release();
    }
  }

  function launchAfterCommit(input: { threadId: ThreadId; seedTurnId: TurnId }) {
    deps.schedulePostCommit(async () => launch(input.seedTurnId));
  }

  async function stop(threadId: ThreadId, seedTurnId: TurnId): Promise<boolean> {
    let stopped = false;
    await deps.threadLock.withThreadLock(threadId, async () => {
      const seed = await deps.repos.turns.findById(seedTurnId);
      if (!seed || seed.threadId !== threadId || seed.role !== "system" ||
        !HandoffSeedMetadataCodec.safeParse(seed.metadata).success || seed.status !== "pending") return;
      const thread = await deps.repos.threads.findById(threadId);
      if (!thread) return;
      await deps.repos.transaction(async () => {
        const completed: Turn = {
          ...seed,
          status: "cancelled",
          finishReason: null,
          error: null,
          completedAt: new Date().toISOString(),
        };
        const historyReadable = await historyReadableAt({ repos: deps.repos, toolRegistry: deps.toolRegistry }, seed);
        await completeHandoffSeed(persistence, completed, handoffSeedBlock(seed, undefined, historyReadable), {});
      });
      stopped = true;
    });
    if (stopped) {
      live.get(seedTurnId)?.controller.abort();
      publishStatus(threadId);
      wake(threadId);
    }
    return stopped;
  }

  async function retry(input: { threadId: ThreadId; seedId: TurnId }) {
    const result = await deps.threadLock.withThreadLock(input.threadId, async () => {
      const existing = await deps.repos.turns.findById(input.seedId);
      if (existing) {
        const metadata = HandoffSeedMetadataCodec.safeParse(existing.metadata);
        if (existing.threadId === input.threadId && existing.role === "system" && metadata.success)
          return { turn: existing, created: false };
        throw new HandoffRetryError("seed_id_conflict");
      }
      const thread = await deps.repos.threads.findById(input.threadId);
      if (!thread || thread.originType !== "handoff") throw new HandoffRetryError("not_a_handoff_retry");
      const latest = await deps.repos.turns.findLatestHandoffSeed(input.threadId);
      if (!latest || latest.status === "pending" || !["error", "cancelled"].includes(latest.status) ||
          (await deps.runClaim.read(input.threadId)).kind === "awake")
        throw new HandoffRetryError("handoff_retry_unavailable");
      const leafId = thread.activeLeafTurnId as TurnId | null;
      const leaf = leafId ? await deps.repos.turns.findById(leafId) : null;
      if (leafId && !leaf) throw new Error("Handoff destination leaf is missing");
      const metadata = HandoffSeedMetadataCodec.parse(latest.metadata);
      const seed = createLocalTurn({
        id: input.seedId,
        threadId: input.threadId,
        position: (leaf?.position ?? 0) + 1,
        prevTurnId: leafId,
        role: "system",
        origin: "system",
        status: "pending",
        metadata: handoffSeedMetadata({
          sourceThreadId: metadata.sourceThreadId,
          sourceRef: metadata.sourceRef,
          sourceTitle: metadata.sourceTitle,
          cutoffTurnId: metadata.cutoffTurnId,
        }),
      });
      const saved = await persistAndAppendTurnStartEvents(
        persistence,
        input.threadId,
        leafId,
        async () => ({ result: seed, events: [{ type: "turn.created", turn: seed }] }),
      );
      const turn = saved.createdTurns[0] ?? seed;
      return { turn, created: true };
    });
    if (result.created) launchAfterCommit({ threadId: input.threadId, seedTurnId: result.turn.id as TurnId });
    return result;
  }

  async function sweep(limit = RECOVERY_PAGE_SIZE): Promise<number> {
    let afterId: TurnId | undefined;
    let count = 0;
    for (;;) {
      const rows = await deps.repos.turns.listPendingHandoffSeeds(limit, afterId);
      if (rows.length === 0) return count;
      for (const row of rows) {
        await launch(row.id as TurnId);
        count += 1;
      }
      afterId = rows.at(-1)?.id as TurnId | undefined;
      if (rows.length < limit) return count;
    }
  }

  return { launch, launchAfterCommit, stop, retry, sweep };
}
