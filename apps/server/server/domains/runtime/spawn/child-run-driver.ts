/** Child-run coordination: admit, drive, and read saved terminal truth; the run session publishes every report. */
import { meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ExecutionReportCorrelation,
  SpawnResult,
  TreeBudget,
} from "@meridian/contracts/spawn";
import type { BlockUpsertedRow, Thread, ThreadActivity } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { LiveEventWriter, ThreadRepositories } from "../../threads/index.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import type { PreparedRun, RunTurnPort } from "../loop/run-turn-port.js";
import { appendSubagentActivityBestEffort } from "./activity-event.js";
import { savedReportToSpawnResult } from "./saved-report-outcome.js";

export interface ChildDriveInput {
  parentThread: Thread;
  parentTurnId: TurnId;
  /** The parent's sending execution: a machine wake the fence checks. */
  parentExecutionId: string;
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
  repos: Pick<ThreadRepositories, "executionReports">;
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
        parentExecutionId: input.parentExecutionId,
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
    if (saved?.outcome) return savedReportToSpawnResult(saved);
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

  return { register, admit, execute, executeBackground };
}
