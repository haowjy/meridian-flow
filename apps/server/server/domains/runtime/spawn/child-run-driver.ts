/**
 * Child-run coordination: admit, drive, and read saved terminal truth. A resolved
 * ask's continuation is read from the ask itself, whoever runs it; the run
 * session publishes every report.
 */
import { meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ExecutionReportCorrelation,
  SavedExecutionReport,
  SpawnResult,
  TreeBudget,
} from "@meridian/contracts/spawn";
import type { BlockUpsertedRow, Thread, ThreadActivity } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type LiveEventWriter,
  type ThreadRepositories,
  TurnStartConflictError,
} from "../../threads/index.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { NoPendingWakeError, type PreparedRun, type RunTurnPort } from "../loop/run-turn-port.js";
import { appendSubagentActivityBestEffort } from "./activity-event.js";
import { savedReportToSpawnResult } from "./saved-report-outcome.js";

export interface ChildDriveInput {
  parentThread: Thread;
  parentTurnId: TurnId;
  prompt: string;
  budget: TreeBudget;
  /** Original parent invocation, including the retained running card. */
  reportCorrelation?: ExecutionReportCorrelation;
}

export type PreparedChild = {
  child: Thread;
  handle: string;
  resolvedSlug: string;
  name?: string;
  seedBlocks?: BlockUpsertedRow[];
  from?: { threadId: ThreadId; ref: string; title: string | null };
  signal?: AbortSignal;
  background: boolean;
  origin: "spawn" | "message";
};

export type AdmittedChildRun = {
  prepared: PreparedChild;
  handle: PreparedRun;
  admittedAt: string;
};

export interface ChildRunDriverDeps {
  backgroundTasks: DetachedWorkTracker;
  orchestrator: RunTurnPort;
  repos: Pick<ThreadRepositories, "executionReports" | "asks">;
  /** Calls `onChange` after each committed event on the thread, in any process. */
  watchThread(threadId: ThreadId, onChange: () => void): Promise<() => void>;
  eventWriter: LiveEventWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  eventSink: EventSink;
}

export interface ChildRunDriver {
  register(
    child: Thread,
    resolvedSlug: string,
    options: { background?: boolean; signal?: AbortSignal; origin: "spawn" | "message" },
  ): Promise<PreparedChild>;
  admit(prepared: PreparedChild, input: ChildDriveInput): Promise<AdmittedChildRun>;
  /**
   * The answered ask's continuation report: drives it when its row is still
   * pending, otherwise waits for whoever runs it. Replays the same way.
   */
  continueAnswered(
    prepared: PreparedChild,
    input: ChildDriveInput,
    askId: string,
  ): Promise<SpawnResult>;
  execute(admitted: AdmittedChildRun): Promise<SpawnResult>;
  executeBackground(admitted: AdmittedChildRun): void;
}

export function createChildRunDriver(deps: ChildRunDriverDeps): ChildRunDriver {
  const backgroundTasks = deps.backgroundTasks;
  async function register(
    child: Thread,
    resolvedSlug: string,
    options: { background?: boolean; signal?: AbortSignal; origin: "spawn" | "message" },
  ): Promise<PreparedChild> {
    if (!child.ref) throw new Error("Prepared child has no project handle");
    return {
      child,
      handle: child.ref,
      resolvedSlug,
      signal: options.signal,
      background: options.background ?? false,
      origin: options.origin,
    };
  }

  async function admit(prepared: PreparedChild, input: ChildDriveInput): Promise<AdmittedChildRun> {
    if (!input.reportCorrelation) {
      throw new Error("Child invocation has no parent report correlation");
    }
    const handle = await deps.orchestrator.prepare({
      threadId: prepared.child.id as ThreadId,
      userText: input.prompt,
      seedBlocks: prepared.seedBlocks,
      signal: prepared.signal,
      child: {
        parentThreadId: input.parentThread.id as ThreadId,
        background: prepared.background,
        origin: prepared.origin,
        sender: { ref: input.parentThread.ref, title: input.parentThread.title },
      },
      treeBudget: input.budget,
      executionReport: {
        correlation: input.reportCorrelation,
        agentSlug: prepared.resolvedSlug,
        name: prepared.name ?? null,
      },
    });
    const report = await deps.repos.executionReports.findByExecution(
      prepared.child.id as ThreadId,
      handle.executionTurnId,
    );
    if (!report) throw new Error("Admitted child run has no execution report");
    return { prepared, handle, admittedAt: report.admittedAt };
  }

  async function continueAnswered(
    prepared: PreparedChild,
    input: ChildDriveInput,
    askId: string,
  ): Promise<SpawnResult> {
    const childThreadId = prepared.child.id as ThreadId;
    const owed = (await deps.repos.asks.findById(askId))?.continuation;
    if (owed === "pending" || owed === "admitted") {
      let handle: PreparedRun | null = null;
      try {
        handle = await deps.orchestrator.prepare({
          threadId: childThreadId,
          drain: true,
          signal: prepared.signal,
          child: {
            parentThreadId: input.parentThread.id as ThreadId,
            background: false,
            origin: prepared.origin,
            sender: { ref: input.parentThread.ref, title: input.parentThread.title },
          },
          treeBudget: input.budget,
        });
      } catch (error) {
        // Another runner (the wake sweep, or a crashed caller's recovery) took it.
        if (!(error instanceof TurnStartConflictError) && !(error instanceof NoPendingWakeError))
          throw error;
      }
      if (handle) await handle.execute();
    }
    return awaitContinuation(childThreadId, askId, prepared.signal);
  }

  /**
   * Waits outside any lock until the ask's continuation is `done` and the run it last
   * admitted is terminal (a forwarded child that crashed mid-relay is admitted again, and
   * its stale-settled first attempt is not the answer), or until it is `cancelled`.
   */
  async function awaitContinuation(
    childThreadId: ThreadId,
    askId: string,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const changes = changeLatch();
    const unwatch = await deps.watchThread(childThreadId, changes.notify);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const ask = await deps.repos.asks.findById(askId);
        if (!ask || ask.continuation === "cancelled")
          return {
            status: "error",
            error: meridianErrorFromSystem("spawn_cancelled", "Child run was cancelled"),
            outcome: "cancelled",
            partial: true,
            reason: "cancelled",
          };
        const report =
          ask.continuation === "done" && ask.continuationTurnId
            ? await deps.repos.executionReports.findByExecution(
                childThreadId,
                ask.continuationTurnId,
              )
            : null;
        if (report?.outcome) return savedResult(report);
        await changes.next(signal);
      }
    } finally {
      unwatch();
    }
  }

  async function savedResult(saved: SavedExecutionReport): Promise<SpawnResult> {
    // The historical question, whatever its status: an answer to a question that
    // already resolved becomes an ordinary message, never a newer question's answer.
    const ask =
      saved.outcome === "asked" && saved.terminalTurnId
        ? (await deps.repos.asks.listByTurnIds([saved.terminalTurnId])).find(
            (candidate) => candidate.kind === "question",
          )
        : null;
    return savedReportToSpawnResult(saved, ask);
  }

  function observeCleanupFailure(prepared: PreparedChild, name: string, error: unknown): void {
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.spawn",
      name,
      correlation: { threadId: prepared.child.id },
      payload: unknownToEventPayload(error),
    });
  }

  async function finish(prepared: PreparedChild, handle: PreparedRun): Promise<SpawnResult> {
    const childThreadId = prepared.child.id as ThreadId;
    const outcome = await handle.execute();

    const saved = await deps.repos.executionReports.findByExecution(
      childThreadId,
      handle.executionTurnId,
    );
    await appendSubagentActivityBestEffort({
      eventWriter: deps.eventWriter,
      readActivity: deps.readActivity,
      parentThreadId: prepared.child.parentThreadId as ThreadId,
      childThreadId,
      eventSink: deps.eventSink,
    });
    if (saved?.outcome) return savedResult(saved);
    return {
      status: "error",
      error: meridianErrorFromSystem(
        "spawn_unavailable",
        outcome.status === "failed"
          ? "Child run failed before a saved terminal report"
          : "Child report is unavailable",
      ),
      execution: handle.executionTurnId,
    };
  }

  async function execute(admitted: AdmittedChildRun): Promise<SpawnResult> {
    return finish(admitted.prepared, admitted.handle);
  }

  function executeBackground(admitted: AdmittedChildRun): void {
    backgroundTasks.track(
      execute(admitted).catch((error) => {
        observeCleanupFailure(admitted.prepared, "child.background_driver_failed", error);
      }),
      "background child completion",
    );
  }

  return { register, admit, continueAnswered, execute, executeBackground };
}

/** A wake-up flag: `next` returns at once if anything changed since the last call. */
function changeLatch() {
  let changed = false;
  let wake: (() => void) | null = null;
  return {
    notify() {
      changed = true;
      wake?.();
    },
    async next(signal?: AbortSignal) {
      if (!changed)
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          const aborted = () => reject(signal?.reason);
          wake = () => {
            signal?.removeEventListener("abort", aborted);
            resolve();
          };
          signal?.addEventListener("abort", aborted, { once: true });
        });
      changed = false;
      wake = null;
    },
  };
}
