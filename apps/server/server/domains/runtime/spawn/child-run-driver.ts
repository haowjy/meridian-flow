/** Child-run coordination: admit, drive, release, then publish saved terminal truth. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ExecutionReportCorrelation,
  SpawnResult,
  TreeBudget,
} from "@meridian/contracts/spawn";
import type { Thread, ThreadActivity } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter, ThreadRepositories } from "../../threads/index.js";
import type { PreparedRun, RunTurnPort } from "../loop/run-turn-port.js";
import { appendSubagentActivityBestEffort } from "./activity-event.js";
import type { ReportPublisher } from "./report-publisher.js";
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
  description?: string;
  signal?: AbortSignal;
  background: boolean;
  origin: "spawn" | "message";
};

export interface ChildRunDriverDeps {
  orchestrator: RunTurnPort;
  repos: Pick<ThreadRepositories, "executionReports">;
  eventWriter: EventJournalWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  publisher: Pick<ReportPublisher, "publish">;
  eventSink: EventSink;
}

export interface ChildRunDriver {
  register(
    child: Thread,
    resolvedSlug: string,
    options: { background?: boolean; signal?: AbortSignal; origin: "spawn" | "message" },
  ): Promise<PreparedChild>;
  drive(
    prepared: PreparedChild,
    input: ChildDriveInput,
    onAdmitted?: (execution: TurnId) => Promise<void>,
  ): Promise<SpawnResult>;
  /** Resolves only after assistant-turn/report admission commits, not after terminal. */
  driveBackground(
    prepared: PreparedChild,
    input: ChildDriveInput,
    onAdmitted?: (execution: TurnId) => Promise<void>,
  ): Promise<TurnId>;
}

export function createChildRunDriver(deps: ChildRunDriverDeps): ChildRunDriver {
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

  async function start(
    prepared: PreparedChild,
    input: ChildDriveInput,
    onAdmitted?: (execution: TurnId) => Promise<void>,
  ): Promise<PreparedRun> {
    if (!input.reportCorrelation) {
      throw new Error("Child invocation has no parent report correlation");
    }
    const handle = await deps.orchestrator.prepare({
      threadId: prepared.child.id as ThreadId,
      userText: input.prompt,
      signal: prepared.signal,
      child: { parentThreadId: input.parentThread.id as ThreadId, background: prepared.background },
      treeBudget: input.budget,
      executionReport: {
        correlation: input.reportCorrelation,
        agentSlug: prepared.resolvedSlug,
        description: prepared.description ?? null,
      },
    });
    try {
      await onAdmitted?.(handle.assistantTurnId);
    } catch (error) {
      observeCleanupFailure(prepared, "child.admission_callback_failed", error);
    }
    return handle;
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

  async function finish(
    prepared: PreparedChild,
    input: ChildDriveInput,
    handle: PreparedRun,
  ): Promise<SpawnResult> {
    const childThreadId = prepared.child.id as ThreadId;
    const outcome = await handle.execute();

    const saved = await deps.repos.executionReports.findByExecution(
      childThreadId,
      handle.assistantTurnId,
    );
    if (saved?.outcome) {
      try {
        await deps.publisher.publish(childThreadId, handle.assistantTurnId);
      } catch (error) {
        observeCleanupFailure(prepared, "child.publication_failed", error);
      }
    }
    await appendSubagentActivityBestEffort({
      eventWriter: deps.eventWriter,
      readActivity: deps.readActivity,
      rootThreadId: (input.parentThread.rootThreadId ?? input.parentThread.id) as ThreadId,
      childThreadId,
      eventSink: deps.eventSink,
    });
    if (saved?.outcome) return savedReportToSpawnResult(saved);
    return {
      status: "error",
      error: meridianErrorFromSystem(
        "spawn_unavailable",
        outcome.status === "failed"
          ? "Child run failed before a saved terminal report"
          : "Child report is unavailable",
      ),
      execution: handle.assistantTurnId,
    };
  }

  async function drive(
    prepared: PreparedChild,
    input: ChildDriveInput,
    onAdmitted?: (execution: TurnId) => Promise<void>,
  ): Promise<SpawnResult> {
    const handle = await start(prepared, input, onAdmitted);
    return finish(prepared, input, handle);
  }

  async function driveBackground(
    prepared: PreparedChild,
    input: ChildDriveInput,
    onAdmitted?: (execution: TurnId) => Promise<void>,
  ): Promise<TurnId> {
    const handle = await start(prepared, input, onAdmitted);
    void finish(prepared, input, handle).catch((error) => {
      observeCleanupFailure(prepared, "child.background_driver_failed", error);
    });
    return handle.assistantTurnId;
  }

  return { register, drive, driveBackground };
}
