/** Owns handoff seed generation, Stop, Retry, accounting, and destination wake-up. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { Thread, Turn } from "@meridian/contracts/threads";
import type { BillingUsagePolicy } from "../../billing/index.js";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type HandoffFailureOutcome,
  HandoffSeedMetadataCodec,
  handoffSeedMetadata,
  type ThreadRepositories,
} from "../../threads/index.js";
import type { EventJournalWriter } from "../../threads/ports/event-journal.js";
import type {
  HandoffBriefHold,
  HandoffBriefLauncher,
} from "../../threads/ports/handoff-brief-launcher.js";
import { type DetachedWorkTracker, processDetachedWork } from "../detached-work.js";
import { historyReadableAt } from "../loop/history-tool-availability.js";
import { createLocalTurn } from "../loop/local-turn.js";
import type { PersistenceDeps } from "../loop/persistence.js";
import { persistAndAppendTurnStartEvents } from "../loop/persistence.js";
import type { RunClaim } from "../loop/ports.js";
import { settleSummaryResponses } from "../loop/settle-summary-responses.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import { createTurnAccounting } from "../loop/turn-accounting.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import type { HandoffBriefStopper } from "../ports/handoff-briefs.js";
import { resolveMaxSpawnDepth } from "../spawn/tree-budget.js";
import type { HandoffBriefOutcome } from "./brief-request.js";
import { completeHandoffSeed, handoffBriefFailedCopy, handoffSeedBlock } from "./seed.js";

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

type BriefAbortReason = "stop" | "lost_claim" | "shutdown";

type BriefGeneration = (input: {
  destination: Thread;
  seed: Turn;
  signal: AbortSignal;
}) => Promise<{ outcome: HandoffBriefOutcome; failure?: HandoffFailureOutcome }>;

type HandoffBriefServiceDeps = {
  backgroundTasks?: DetachedWorkTracker;
  repos: ThreadRepositories;
  eventWriter: EventJournalWriter;
  eventSink: EventSink;
  threadLock: ThreadLock;
  runClaim: Pick<RunClaim, "hold">;
  wakeIfRunnable(threadId: ThreadId): Promise<void>;
  billingUsage: Pick<BillingUsagePolicy, "canStartTurn">;
  toolRegistry?: Pick<import("../tools/types.js").ToolRegistry, "getRegistration">;
  generate: BriefGeneration;
  publishStatus(threadId: ThreadId): Promise<void>;
  schedulePostCommit(task: () => Promise<void>): void;
};

type LiveBrief = { controller: AbortController; threadId: ThreadId };

export interface HandoffBriefs extends HandoffBriefStopper, HandoffBriefLauncher {
  retry(input: { threadId: ThreadId; seedId: TurnId }): Promise<{ turn: Turn; created: boolean }>;
  beginShutdown(): void;
}

export function createHandoffBriefs(deps: HandoffBriefServiceDeps): HandoffBriefs {
  const persistence: PersistenceDeps = {
    repos: deps.repos,
    eventWriter: deps.eventWriter,
  };
  const live = new Map<TurnId, LiveBrief>();
  const backgroundTasks = deps.backgroundTasks ?? processDetachedWork;
  let shuttingDown = false;
  const accounting = createTurnAccounting({
    billingUsage: deps.billingUsage as BillingUsagePolicy,
  });
  const treeBudget = createDefaultTreeBudget({ maxDepth: resolveMaxSpawnDepth(process.env) });

  function schedulePostCommit(task: () => Promise<void>) {
    deps.schedulePostCommit(() => backgroundTasks.track(Promise.resolve().then(task)));
  }

  function publishStatus(threadId: ThreadId) {
    schedulePostCommit(async () => {
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

  async function wakeAfterRelease(threadId: ThreadId) {
    if (shuttingDown) return;
    try {
      await deps.wakeIfRunnable(threadId);
    } catch (error) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "runtime.handoff",
        name: "wake.failed",
        correlation: { threadId },
        payload: unknownToEventPayload(error),
      });
    }
  }

  async function holdDestination(threadId: ThreadId): Promise<HandoffBriefHold | null> {
    const claim = await deps.runClaim.hold(threadId);
    if (!claim) return null;
    let released = false;
    return {
      onLost: (listener) => claim.onLost(listener),
      async release() {
        if (released) return;
        released = true;
        try {
          await claim.release();
        } finally {
          await wakeAfterRelease(threadId);
        }
      },
    };
  }

  async function currentSeed(seedTurnId: TurnId): Promise<{ seed: Turn; thread: Thread } | null> {
    const seed = await deps.repos.turns.findById(seedTurnId);
    if (seed?.role !== "system" || !HandoffSeedMetadataCodec.safeParse(seed.metadata).success)
      return null;
    const thread = await deps.repos.threads.findById(seed.threadId);
    return thread ? { seed, thread } : null;
  }

  async function settleResponses(
    thread: Thread,
    rows: readonly SummaryOutcome["modelResponses"][number][],
  ) {
    await settleSummaryResponses({ deps: persistence, thread, rows, accounting, treeBudget });
  }

  async function terminalSeed(
    seed: Turn,
    outcome: HandoffBriefOutcome,
    failure?: HandoffFailureOutcome,
    cause?: string,
  ) {
    const success = outcome.kind === "complete";
    const cancelled = outcome.kind === "cancelled";
    const completed: Turn = {
      ...seed,
      status: success ? "complete" : cancelled ? "cancelled" : "error",
      finishReason: success ? "end_turn" : cancelled ? null : "error",
      error: success || cancelled ? null : handoffBriefFailedCopy,
      completedAt: new Date().toISOString(),
    };
    const readable = await historyReadableAt(
      { repos: deps.repos, toolRegistry: deps.toolRegistry },
      seed,
    );
    const block = handoffSeedBlock(
      seed,
      success ? { text: outcome.text, model: outcome.model } : undefined,
      readable,
    );
    return completeHandoffSeed(persistence, completed, block, {
      ...("summarizer" in outcome && outcome.summarizer ? { summarizer: outcome.summarizer } : {}),
      ...(failure ? { failure } : {}),
      ...(cause ? { cause } : {}),
    });
  }

  async function finish(
    threadId: ThreadId,
    seedTurnId: TurnId,
    generation: { outcome: HandoffBriefOutcome; failure?: HandoffFailureOutcome },
    abortReason?: BriefAbortReason,
  ): Promise<void> {
    const { outcome, failure } = generation;
    let settled = false;
    await deps.threadLock.withThreadLock(threadId, () =>
      deps.repos.transaction(async () => {
        const saved = await deps.repos.turns.findById(seedTurnId);
        const thread = await deps.repos.threads.findById(threadId);
        if (!saved || !thread) throw new Error("Handoff seed or destination disappeared");
        if (saved.status !== "pending") {
          await settleResponses(thread, outcome.modelResponses);
          return;
        }
        if (abortReason && abortReason !== "stop") {
          await settleResponses(thread, outcome.modelResponses);
          return;
        }
        if (outcome.kind === "cancelled" && abortReason !== "stop") {
          await settleResponses(thread, outcome.modelResponses);
          return;
        }
        await terminalSeed(saved, outcome, failure);
        await settleResponses(thread, outcome.modelResponses);
        settled = true;
      }),
    );
    if (settled) publishStatus(threadId);
  }

  async function launch(input: {
    threadId: ThreadId;
    seedTurnId: TurnId;
    claim: HandoffBriefHold;
  }): Promise<void> {
    const controller = new AbortController();
    const holder: LiveBrief = { controller, threadId: input.threadId };
    live.set(input.seedTurnId, holder);
    const removeLost = input.claim.onLost(() => controller.abort("lost_claim"));
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      const initial = await currentSeed(input.seedTurnId);
      if (!initial || initial.thread.id !== input.threadId || initial.seed.status !== "pending")
        return;
      publishStatus(initial.thread.id);
      if (!(await deps.billingUsage.canStartTurn(initial.thread.userId))) {
        await finish(input.threadId, input.seedTurnId, {
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
      if (controller.signal.aborted) {
        await finish(
          input.threadId,
          input.seedTurnId,
          {
            outcome: {
              kind: "cancelled",
              modelResponses: [],
              summarizer: { path: "rolling", segments: 0 },
            },
          },
          controller.signal.reason as BriefAbortReason | undefined,
        );
        return;
      }
      poll = setInterval(() => {
        backgroundTasks.track(
          deps.repos.turns
            .findById(input.seedTurnId)
            .then((seed) => {
              if (!seed) controller.abort("lost_claim");
              else if (seed.status !== "pending")
                controller.abort(seed.status === "cancelled" ? "stop" : "lost_claim");
            })
            .catch((error) => {
              emitEvent(deps.eventSink, {
                level: "warn",
                source: "runtime.handoff",
                name: "stop_poll.failed",
                correlation: { threadId: input.threadId, turnId: input.seedTurnId },
                payload: unknownToEventPayload(error),
              });
            }),
        );
      }, REMOTE_STOP_POLL_MS);
      poll.unref();

      let generated: Awaited<ReturnType<BriefGeneration>>;
      try {
        generated = await deps.generate({
          destination: initial.thread,
          seed: initial.seed,
          signal: controller.signal,
        });
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
      await finish(
        input.threadId,
        input.seedTurnId,
        generated,
        controller.signal.aborted
          ? (controller.signal.reason as BriefAbortReason | undefined)
          : undefined,
      );
    } finally {
      if (poll) clearInterval(poll);
      removeLost();
      if (live.get(input.seedTurnId) === holder) live.delete(input.seedTurnId);
      try {
        await input.claim.release();
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "error",
          source: "runtime.handoff",
          name: "claim.release_failed",
          correlation: { threadId: input.threadId },
          payload: unknownToEventPayload(error),
        });
      }
    }
  }

  function startLaunch(input: {
    threadId: ThreadId;
    seedTurnId: TurnId;
    claim: HandoffBriefHold;
  }): Promise<void> {
    if (shuttingDown) {
      return input.claim.release().catch((error) => {
        emitEvent(deps.eventSink, {
          level: "error",
          source: "runtime.handoff",
          name: "claim.release_failed",
          correlation: { threadId: input.threadId },
          payload: unknownToEventPayload(error),
        });
      });
    }
    return launch(input).catch((error) => {
      emitEvent(deps.eventSink, {
        level: "error",
        source: "runtime.handoff",
        name: "brief.failed",
        correlation: { threadId: input.threadId, turnId: input.seedTurnId },
        payload: unknownToEventPayload(error),
      });
    });
  }

  function launchAfterCommit(input: {
    threadId: ThreadId;
    seedTurnId: TurnId;
    claim: HandoffBriefHold;
  }) {
    deps.schedulePostCommit(async () => {
      backgroundTasks.track(startLaunch(input));
    });
  }

  async function stop(threadId: ThreadId, seedTurnId: TurnId): Promise<boolean> {
    let stopped = false;
    await deps.threadLock.withThreadLock(threadId, async () => {
      const seed = await deps.repos.turns.findById(seedTurnId);
      if (
        !seed ||
        seed.threadId !== threadId ||
        seed.role !== "system" ||
        !HandoffSeedMetadataCodec.safeParse(seed.metadata).success ||
        seed.status !== "pending"
      )
        return;
      await deps.repos.transaction(async () => {
        const completed: Turn = {
          ...seed,
          status: "cancelled",
          finishReason: null,
          error: null,
          completedAt: new Date().toISOString(),
        };
        const readable = await historyReadableAt(
          { repos: deps.repos, toolRegistry: deps.toolRegistry },
          seed,
        );
        await completeHandoffSeed(
          persistence,
          completed,
          handoffSeedBlock(seed, undefined, readable),
          {},
        );
      });
      stopped = true;
    });
    if (stopped) {
      live.get(seedTurnId)?.controller.abort("stop");
      publishStatus(threadId);
      schedulePostCommit(async () => {
        if (shuttingDown) return;
        try {
          await deps.wakeIfRunnable(threadId);
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
    return stopped;
  }

  async function retry(input: { threadId: ThreadId; seedId: TurnId }) {
    const existing = await deps.repos.turns.findById(input.seedId);
    if (existing) {
      const metadata = HandoffSeedMetadataCodec.safeParse(existing.metadata);
      if (existing.threadId === input.threadId && existing.role === "system" && metadata.success)
        return { turn: existing, created: false };
      throw new HandoffRetryError("seed_id_conflict");
    }
    const claim = await holdDestination(input.threadId);
    if (!claim) throw new HandoffRetryError("handoff_retry_unavailable");
    try {
      const result = await deps.threadLock.withThreadLock(input.threadId, async () => {
        const duplicate = await deps.repos.turns.findById(input.seedId);
        if (duplicate) {
          const metadata = HandoffSeedMetadataCodec.safeParse(duplicate.metadata);
          if (
            duplicate.threadId === input.threadId &&
            duplicate.role === "system" &&
            metadata.success
          )
            return { turn: duplicate, created: false };
          throw new HandoffRetryError("seed_id_conflict");
        }
        const thread = await deps.repos.threads.findById(input.threadId);
        if (thread?.originType !== "handoff") throw new HandoffRetryError("not_a_handoff_retry");
        const latest = await deps.repos.turns.findLatestHandoffSeed(input.threadId);
        if (
          !latest ||
          latest.status === "pending" ||
          !["error", "cancelled"].includes(latest.status)
        )
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
        return { turn: saved.createdTurns[0] ?? seed, created: true };
      });
      if (result.created)
        launchAfterCommit({ threadId: input.threadId, seedTurnId: result.turn.id, claim });
      else await claim.release();
      return result;
    } catch (error) {
      await claim.release();
      throw error;
    }
  }

  function beginShutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const brief of live.values()) brief.controller.abort("shutdown");
  }

  return {
    hold: holdDestination,
    launchAfterCommit,
    stop,
    retry,
    beginShutdown,
  };
}
