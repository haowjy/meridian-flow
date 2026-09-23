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
import type { Lease, RunAuthority } from "../loop/ports.js";
import type { RunTurnHandle, RunTurnPort } from "../loop/run-turn-port.js";
import type { ChildRunRegistry } from "../loop/turn-runner.js";
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
  childController: AbortController;
  childRegistered: boolean;
  runLease: Lease;
  background: boolean;
  origin: "spawn" | "message";
};

export interface ChildRunDriverDeps {
  orchestrator: RunTurnPort;
  repos: Pick<ThreadRepositories, "executionReports">;
  eventWriter: EventJournalWriter;
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  childRunRegistry: ChildRunRegistry;
  workContextDelivery: { flushOwned(threadId: ThreadId): Promise<void> };
  runAuthority: RunAuthority;
  publisher: Pick<ReportPublisher, "publish">;
  eventSink: EventSink;
}

export interface ChildRunDriver {
  register(
    child: Thread,
    resolvedSlug: string,
    options: { background?: boolean; signal?: AbortSignal; origin: "spawn" | "message" },
  ): Promise<PreparedChild>;
  release(prepared: PreparedChild): Promise<void>;
  drive(prepared: PreparedChild, input: ChildDriveInput): Promise<SpawnResult>;
  /** Resolves only after assistant-turn/report admission commits, not after terminal. */
  driveBackground(prepared: PreparedChild, input: ChildDriveInput): Promise<TurnId>;
}

export function createChildRunDriver(deps: ChildRunDriverDeps): ChildRunDriver {
  const runAuthority = deps.runAuthority;

  async function register(
    child: Thread,
    resolvedSlug: string,
    options: { background?: boolean; signal?: AbortSignal; origin: "spawn" | "message" },
  ): Promise<PreparedChild> {
    const parentThreadId = child.parentThreadId as ThreadId;
    const childThreadId = child.id as ThreadId;
    const handle = child.ref;
    if (!handle) throw new Error("Prepared child has no project handle");
    const childController = new AbortController();
    let runLease: Lease | null = null;
    try {
      runLease = await runAuthority.acquire(childThreadId, crypto.randomUUID());
      if (!runLease) throw new Error("Child thread already has an active run");
      if (options.background) {
        deps.childRunRegistry.registerBackgroundChild(
          parentThreadId,
          childThreadId,
          childController,
        );
      } else {
        const parentSignal = options.signal;
        if (parentSignal) {
          if (parentSignal.aborted) childController.abort();
          else
            parentSignal.addEventListener("abort", () => childController.abort(), { once: true });
        }
        deps.childRunRegistry.registerChild(parentThreadId, childThreadId, childController);
      }
      return {
        child,
        handle,
        resolvedSlug,
        childController,
        childRegistered: true,
        runLease,
        background: options.background ?? false,
        origin: options.origin,
      };
    } catch (error) {
      childController.abort();
      deps.childRunRegistry.unregisterChild(childThreadId);
      if (runLease) await runAuthority.release(runLease);
      throw error;
    }
  }

  async function release(prepared: PreparedChild): Promise<void> {
    prepared.childController.abort();
    deps.childRunRegistry.unregisterChild(prepared.child.id as ThreadId);
    await runAuthority.release(prepared.runLease);
  }

  async function start(prepared: PreparedChild, input: ChildDriveInput): Promise<RunTurnHandle> {
    if (!input.reportCorrelation) {
      throw new Error("Child invocation has no parent report correlation");
    }
    const handle = await deps.orchestrator.runTurn({
      threadId: prepared.child.id as ThreadId,
      userText: input.prompt,
      signal: prepared.childController.signal,
      treeBudget: input.budget,
      lease: prepared.runLease,
      executionReport: {
        correlation: input.reportCorrelation,
        agentSlug: prepared.resolvedSlug,
        description: prepared.description ?? null,
      },
    });
    deps.childRunRegistry.markChildTurn(prepared.child.id as ThreadId, handle.assistantTurnId);
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

  async function cleanup(prepared: PreparedChild): Promise<void> {
    const childThreadId = prepared.child.id as ThreadId;
    deps.childRunRegistry.abortChildrenOf(childThreadId, { includeBackground: true });
    try {
      if (prepared.childRegistered) await deps.workContextDelivery.flushOwned(childThreadId);
    } catch (error) {
      observeCleanupFailure(prepared, "child.work_context_flush_failed", error);
    } finally {
      deps.childRunRegistry.unregisterChild(childThreadId);
      try {
        await runAuthority.release(prepared.runLease);
      } catch (error) {
        observeCleanupFailure(prepared, "child.lease_release_failed", error);
      }
    }
  }

  async function finish(
    prepared: PreparedChild,
    input: ChildDriveInput,
    handle: RunTurnHandle,
  ): Promise<SpawnResult> {
    const childThreadId = prepared.child.id as ThreadId;
    let generatorError: unknown;
    try {
      for await (const _event of handle.events) {
        // The orchestrator persists and journals its events while driving.
      }
    } catch (error) {
      generatorError = error;
      try {
        await deps.orchestrator.finalizeGeneratorFailure({
          threadId: childThreadId,
          assistantTurnId: handle.assistantTurnId,
          error,
          signal: prepared.childController.signal,
          lease: prepared.runLease,
        });
      } catch (failure) {
        observeCleanupFailure(prepared, "child.generator_finalization_failed", failure);
      }
    } finally {
      await cleanup(prepared);
    }

    const saved = await deps.repos.executionReports.findByExecution(
      childThreadId,
      handle.assistantTurnId,
    );
    if (saved?.outcome !== null && saved?.outcome !== undefined) {
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
        generatorError
          ? "Child run failed before a saved terminal report"
          : "Child report is unavailable",
      ),
      execution: handle.assistantTurnId,
    };
  }

  async function drive(prepared: PreparedChild, input: ChildDriveInput): Promise<SpawnResult> {
    let handle: RunTurnHandle;
    try {
      handle = await start(prepared, input);
    } catch (error) {
      // Setup failed before a terminal transaction. The child lease must not
      // survive an unadmitted invocation, and no completion is fabricated.
      await cleanup(prepared);
      throw error;
    }
    return finish(prepared, input, handle);
  }

  async function driveBackground(prepared: PreparedChild, input: ChildDriveInput): Promise<TurnId> {
    let handle: RunTurnHandle;
    try {
      handle = await start(prepared, input);
    } catch (error) {
      await cleanup(prepared);
      throw error;
    }
    void finish(prepared, input, handle).catch((error) => {
      observeCleanupFailure(prepared, "child.background_driver_failed", error);
    });
    return handle.assistantTurnId;
  }

  return { register, release, drive, driveBackground };
}
