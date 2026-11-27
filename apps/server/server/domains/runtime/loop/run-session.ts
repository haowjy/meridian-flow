import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  type HandBackRequest,
  isTerminalTurnStatus,
  type SendNowRequest,
  type SendNowResponse,
  type StopRequest,
  type StopResponse,
  type Turn,
} from "@meridian/contracts/threads";
import type { DetachedWorkTracker } from "../../../shared/detached-work.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type ThreadRepository,
  type TurnRepository,
  TurnStartConflictError,
} from "../../threads/index.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import type { HandoffBriefStopper } from "../ports/handoff-briefs.js";
import type { RuntimeDelivery } from "./delivery/runtime-delivery.js";
import { latestRowAt } from "./latest-row.js";
import { createLocalTurn } from "./local-turn.js";
import { type CurrentTurn, DEFAULT_LEASE_TTL_MS, type Lease, type RunClaim } from "./ports.js";
import {
  NoPendingWakeError,
  type PreparedLoop,
  type PreparedRun,
  ReplyRetryPendingError,
  ReplyRetryUnavailableError,
  type RunLoopInput,
  type RunOutcome,
  type RunTurnInput,
  RuntimeShuttingDownError,
  UnsettledPlaceholderError,
} from "./run-turn-port.js";

type RunSession = {
  controller: AbortController;
  currentTurn: CurrentTurn | null;
  executionId: string | null;
  startedAt: Date;
  child?: RunTurnInput["child"];
  completion: Promise<void>;
};

export type LineageReach =
  | { kind: "thread" }
  | { kind: "turn"; turnId: TurnId }
  | { kind: "terminal" }
  | { kind: "deleted" };

export type LineageDecision<T> = {
  result: T;
  reach: LineageReach | null;
  execution: string | null;
  fenceOwner?: boolean;
};

export type LineageCancelled<T> = {
  result: T;
  execution: string | null;
  targets: ThreadId[];
};

export type LineageCancellation = {
  cancel<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
  ): Promise<LineageCancelled<T>>;
  endSubtree(threadId: ThreadId): Promise<ThreadId[]>;
};

export type RunSessionReports = {
  publish(threadId: ThreadId, executionTurnId: TurnId): Promise<unknown>;
};

export function createRunSessions(deps: {
  shutdown: { started: boolean };
  backgroundTasks: DetachedWorkTracker;
  setup(input: RunLoopInput): Promise<PreparedLoop>;
  finalizeFailure(input: {
    threadId: ThreadId;
    turnId: TurnId;
    error: unknown;
    signal: AbortSignal;
    lease: Lease;
  }): Promise<Turn>;
  runClaim: RunClaim;
  delivery: Pick<
    RuntimeDelivery,
    | "settleStaleExecution"
    | "releaseExecution"
    | "selectPending"
    | "answerRunState"
    | "stop"
    | "handBack"
    | "sendNow"
  >;
  handoffBriefs: HandoffBriefStopper;
  repos: {
    turns: TurnRepository;
    threads: Pick<ThreadRepository, "findById" | "listSubtreeIds">;
  };
  headSeq(threadId: ThreadId): Promise<bigint>;
  eventSink: EventSink;
  wakeIfRunnable(threadId: ThreadId): Promise<void>;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
  lineage: LineageCancellation;
  reports: RunSessionReports;
  afterCommit(task: () => void): void;
}) {
  const running = new Map<ThreadId, RunSession>();
  const shutdown = deps.shutdown;
  const backgroundTasks = deps.backgroundTasks;
  const authority = deps.runClaim;
  function observe(threadId: ThreadId, name: string, error: unknown) {
    emitEvent(deps.eventSink, {
      level: "error",
      source: "runtime.run-session",
      name,
      correlation: { threadId },
      payload: unknownToEventPayload(error),
    });
  }
  function abortChildrenOf(parentThreadId: ThreadId) {
    for (const [id, session] of running) {
      if (session.child?.parentThreadId !== parentThreadId || session.child.background) continue;
      abortChildrenOf(id);
      session.controller.abort();
    }
  }

  function confirmedSession(threadId: ThreadId, cancelledExecutionId: string | null) {
    const active = running.get(threadId);
    return active && cancelledExecutionId !== null && cancelledExecutionId === active.executionId
      ? active
      : null;
  }

  async function cancelLineage<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
  ): Promise<T> {
    const ended = await deps.lineage.cancel(threadId, decide);
    deps.afterCommit(() => {
      confirmedSession(threadId, ended.execution)?.controller.abort();
      abortAll(ended.targets);
    });
    return ended.result;
  }

  function abortAll(threadIds: readonly ThreadId[]) {
    for (const id of threadIds) running.get(id)?.controller.abort();
  }

  async function prepare(input: RunTurnInput): Promise<PreparedRun> {
    const { threadId } = input;
    if (shutdown.started) throw new RuntimeShuttingDownError(threadId);
    if (running.has(threadId)) throw new TurnStartConflictError(threadId, "already_running");
    const controller = new AbortController();
    let complete!: () => void;
    const session: RunSession = {
      controller,
      currentTurn: null,
      executionId: null,
      startedAt: new Date(),
      child: input.child,
      completion: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    };
    running.set(threadId, session);
    const abort = () => controller.abort();
    const parentSignal = input.child?.background ? undefined : input.signal;
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    let lease: Lease | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let preparedRun = false;
    let setupMayWake = false;
    const cancelOwnLineage = () =>
      deps.lineage
        .endSubtree(threadId)
        .then(abortAll)
        .catch((error) => observe(threadId, "lineage.cancel_failed", error));
    async function cleanup() {
      clearInterval(heartbeat);
      parentSignal?.removeEventListener("abort", abort);
      running.delete(threadId);
      if (!input.child) abortChildrenOf(threadId);
      let claimReleased = !lease;
      let wakeAfterRelease = false;
      try {
        if (lease) {
          await deps.delivery.releaseExecution(lease);
          claimReleased = true;
          wakeAfterRelease =
            preparedRun || setupMayWake || ("replyTurnId" in input && !!input.replyTurnId);
        }
      } catch (error) {
        observe(threadId, "lease_release.failed", error);
      } finally {
        complete();
        try {
          if (preparedRun) deps.onRunSettled?.(threadId);
        } catch (error) {
          observe(threadId, "settled.failed", error);
        }
        if (claimReleased && wakeAfterRelease) {
          backgroundTasks.track(
            session.completion
              .then(() => deps.wakeIfRunnable(threadId))
              .catch((error) => observe(threadId, "cleanup_wake.failed", error)),
            "run cleanup wake",
          );
        }
      }
    }
    try {
      lease = await authority.startExecution(threadId, crypto.randomUUID(), () =>
        deps.delivery.settleStaleExecution(threadId),
      );
      if (!lease) throw new TurnStartConflictError(threadId, "already_running");
      if (shutdown.started) throw new RuntimeShuttingDownError(threadId);
      const heldLease = lease;
      session.executionId = heldLease.executionId;
      heartbeat = setInterval(
        () => {
          backgroundTasks.track(
            authority
              .renew(heldLease)
              .then(async (held) => {
                if (!held) {
                  clearInterval(heartbeat);
                  observe(threadId, "lease.lost", new Error("Run lease lost"));
                  controller.abort();
                } else {
                  const state = await authority.read(threadId);
                  if (state.kind === "awake" && state.cancelRequested) controller.abort();
                }
              })
              .catch((error) => observe(threadId, "lease_renew.failed", error)),
            "run lease renewal",
          );
        },
        Math.floor(DEFAULT_LEASE_TTL_MS / 3),
      );
      heartbeat.unref();
      const resumeAfterSeq = (await deps.headSeq(threadId)).toString();
      const loop = await deps.setup({
        ...input,
        signal: controller.signal,
        lease,
        onCurrentTurnChanged(turn) {
          session.currentTurn = turn;
          input.onCurrentTurnChanged?.(turn);
        },
      });
      session.currentTurn = loop.currentTurn;
      const executionTurnId = loop.currentTurn.id;
      if (shutdown.started) throw new RuntimeShuttingDownError(threadId);
      preparedRun = true;
      const snapshotFloorNextSeq = ((await deps.headSeq(threadId)) + 1n).toString();
      try {
        deps.onRunStarted?.(threadId);
      } catch (error) {
        observe(threadId, "started.failed", error);
      }
      let execution: Promise<RunOutcome> | undefined;
      async function execute(): Promise<RunOutcome> {
        let outcome: RunOutcome;
        try {
          let turn: Turn;
          try {
            turn = await loop.execute();
          } catch (error) {
            observe(threadId, "execution.failed", error);
            if (error instanceof UnsettledPlaceholderError) {
              throw error;
            }
            turn = await deps.finalizeFailure({
              threadId,
              turnId: session.currentTurn?.id ?? loop.currentTurn.id,
              error,
              signal: controller.signal,
              lease: heldLease,
            });
          }
          outcome = { status: turn.status as "complete" | "cancelled" | "error", turn };
        } catch (error) {
          observe(threadId, "terminal_fallback.failed", error);
          outcome = { status: "failed", error };
        }
        await deps.reports
          .publish(threadId, executionTurnId)
          .catch((error) => observe(threadId, "report.publish_failed", error));
        if (input.child) await cancelOwnLineage();
        await cleanup();
        return outcome;
      }
      return {
        executionId: lease.executionId,
        userTurnId: loop.userTurnId,
        executionTurnId: loop.currentTurn.id,
        resumeAfterSeq,
        snapshotFloorNextSeq,
        execute: () => (execution ??= execute()),
      };
    } catch (error) {
      setupMayWake = error instanceof NoPendingWakeError || isAbortError(error);
      if (lease && session.currentTurn) {
        try {
          await deps.finalizeFailure({
            threadId,
            turnId: session.currentTurn.id,
            error,
            signal: controller.signal,
            lease,
          });
        } catch (failure) {
          observe(threadId, "terminal_fallback.failed", failure);
        }
        if (input.child) await cancelOwnLineage();
      }
      await cleanup();
      throw error;
    }
  }

  async function startDrain(threadId: ThreadId): Promise<void> {
    try {
      const run = await prepare({ threadId, drain: true });
      backgroundTasks.track(run.execute(), "detached run execution");
    } catch (error) {
      if (
        !(error instanceof NoPendingWakeError) &&
        !(error instanceof RuntimeShuttingDownError) &&
        !isAbortError(error)
      )
        throw error;
    }
  }
  return {
    prepare,
    async retryReply(input: { threadId: ThreadId; failedTurnId: TurnId; replyTurnId: TurnId }) {
      const answered = async <T extends object>(result: T) => ({
        ...result,
        runState: await deps.delivery.answerRunState(input.threadId),
      });
      const accepted = async () => {
        const existing = await deps.repos.turns.findById(input.replyTurnId);
        if (existing) {
          if (existing.threadId !== input.threadId || existing.role !== "assistant")
            throw new ReplyRetryUnavailableError(input.threadId);
          return { created: false as const, turn: existing, executionId: existing.executionId };
        }
        const retrying = await deps.repos.turns.findRetryReservation(
          input.threadId,
          input.replyTurnId,
        );
        return retrying
          ? { created: false as const, turn: null, executionId: retrying.executionId }
          : null;
      };
      const replay = await accepted();
      if (replay) return answered(replay);
      const refuse = async (refusal: Error = new ReplyRetryUnavailableError(input.threadId)) => {
        const raced = await accepted();
        if (raced) return answered(raced);
        throw refusal;
      };

      const [failedTurn, leafThread, latestTurn, runState] = await Promise.all([
        deps.repos.turns.findById(input.failedTurnId),
        deps.repos.threads.findById(input.threadId),
        turnGraph(deps.repos.turns).latest(input.threadId),
        authority.read(input.threadId),
      ]);
      if (shutdown.started) return refuse(new RuntimeShuttingDownError(input.threadId));
      if (running.has(input.threadId) || runState.kind === "awake") {
        if ((await authority.readOpenExecutionId(input.threadId)) === null)
          throw new ReplyRetryPendingError(input.threadId);
        return refuse();
      }
      if (
        !failedTurn ||
        failedTurn.threadId !== input.threadId ||
        failedTurn.role !== "assistant" ||
        failedTurn.status !== "error" ||
        !latestTurn ||
        (await latestRowAt(deps.repos.turns, leafThread?.activeLeafTurnId ?? null)).latest?.id !==
          failedTurn.id
      )
        return refuse();

      let run: PreparedRun;
      try {
        run = await prepare({
          threadId: input.threadId,
          drain: true,
          replyTurnId: input.replyTurnId,
          retryOf: input.failedTurnId,
        });
      } catch (error) {
        const raced = await accepted();
        if (raced) return answered(raced);
        if (error instanceof TurnStartConflictError)
          throw new ReplyRetryPendingError(input.threadId);
        if (error instanceof NoPendingWakeError)
          throw new ReplyRetryUnavailableError(input.threadId);
        throw error;
      }
      backgroundTasks.track(run.execute(), "detached reply retry");
      const describe = async (prepared: PreparedRun): Promise<Turn> => {
        const [persisted, firstTurn, thread] = await Promise.all([
          deps.repos.turns.findById(input.replyTurnId),
          deps.repos.turns.findById(prepared.executionTurnId),
          deps.repos.threads.findById(input.threadId),
        ]);
        return (
          persisted ??
          createLocalTurn({
            id: input.replyTurnId,
            threadId: input.threadId,
            prevTurnId: firstTurn?.role === "compaction" ? firstTurn.id : latestTurn.id,
            position:
              (firstTurn?.role === "compaction" ? firstTurn.position : latestTurn.position) + 1,
            role: "assistant",
            origin: "assistant",
            status: "pending",
            writeMode: thread?.aiWriteMode,
            executionId: prepared.executionId,
          })
        );
      };
      const turn = await describe(run).catch((error: unknown) => {
        observe(input.threadId, "retry.describe_failed", error);
        return null;
      });
      return answered({ created: true as const, turn, executionId: run.executionId });
    },
    startDrain,
    getRunningTurn(threadId: ThreadId) {
      const session = running.get(threadId);
      return session
        ? {
            turnId: session.currentTurn?.id ?? null,
            kind: session.currentTurn?.kind ?? null,
            startedAt: session.startedAt,
          }
        : null;
    },
    getRunningTurnId: (threadId: ThreadId) => running.get(threadId)?.currentTurn?.id ?? null,
    isThreadRunning: (threadId: ThreadId) => running.has(threadId),
    beginShutdown() {
      shutdown.started = true;
      for (const session of running.values()) session.controller.abort("shutdown");
    },
    stop: (threadId: ThreadId, request: StopRequest): Promise<StopResponse> =>
      cancelLineage(threadId, async () => {
        const response = await deps.delivery.stop(threadId, request);
        const thread = await deps.repos.threads.findById(threadId);
        return {
          result: response,
          reach: { kind: "thread" },
          execution: response.cancelledExecutionId,
          fenceOwner: thread?.parentThreadId != null,
        };
      }),
    handBack: (threadId: ThreadId, request: HandBackRequest) =>
      deps.delivery.handBack(threadId, request),
    sendNow: (threadId: ThreadId, request: SendNowRequest): Promise<SendNowResponse> =>
      cancelLineage(threadId, async () => {
        const response = await deps.delivery.sendNow(threadId, request);
        const execution = response.cancelledExecutionId;
        return {
          result: response,
          reach: execution ? { kind: "thread" } : null,
          execution,
        };
      }),
    async cancel(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<"cancelled" | "already_finished" | "not_found"> {
      const turn = await deps.repos.turns.findById(turnId);
      if (!turn || turn.threadId !== threadId) return "not_found";
      if (await deps.handoffBriefs.stop(threadId, turnId)) return "cancelled";
      return cancelLineage(threadId, async () => {
        const live = await authority.cancelExecution(threadId, turnId);
        const current = live ? turn : await deps.repos.turns.findById(turnId);
        if (!live && current?.status !== "awaiting_answer")
          return {
            result:
              (current && isTerminalTurnStatus(current.status)) || running.has(threadId)
                ? ("already_finished" as const)
                : ("not_found" as const),
            reach: null,
            execution: null,
          };
        return {
          result: "cancelled" as const,
          reach: { kind: "turn", turnId },
          execution: live ? turn.executionId : null,
        };
      });
    },
    async stopThreads(threadIds: readonly ThreadId[]): Promise<void> {
      for (const threadId of await lineageOwners(threadIds))
        await cancelLineage(threadId, async () => ({
          result: undefined,
          reach: { kind: "deleted" },
          execution: running.get(threadId)?.executionId ?? null,
        }));
    },
  };

  async function lineageOwners(threadIds: readonly ThreadId[]): Promise<ThreadId[]> {
    const subtrees = await Promise.all(
      threadIds.map((threadId) => deps.repos.threads.listSubtreeIds(threadId)),
    );
    const covered = new Set(subtrees.flat());
    return threadIds.filter((id) => !covered.has(id));
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type TurnRunner = ReturnType<typeof createRunSessions>;
export type RunningTurnView = NonNullable<ReturnType<TurnRunner["getRunningTurn"]>>;
