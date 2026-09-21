/**
 * ChildRunDriver — the child-run lifecycle from claim to terminal persistence.
 * Registers a prepared child (run claim, registry, abort controller), drives its
 * runTurn to terminal state, captures return_result in a per-run closure, and
 * persists the terminal lifecycle, event, and background report message.
 * Invocation resolution and writer-card policy stay with the coordinator.
 */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AgentReport,
  ReturnResultCapture,
  SpawnResult,
  TreeBudget,
} from "@meridian/contracts/spawn";
import { blockPlainText, type Thread, type ThreadActivity } from "@meridian/contracts/threads";
import type { BillingSpendReader } from "../../billing/index.js";
import type { EventSink } from "../../observability/index.js";
import type { WorkContextDelivery } from "../../projects/index.js";
import type {
  BlockRepository,
  EventJournalWriter,
  ThreadRepositories,
  ThreadRepository,
  TurnRepository,
} from "../../threads/index.js";
import type { Lease, RunAuthority } from "../loop/ports.js";
import type { ReturnResultCompleter, RunTurnPort } from "../loop/run-turn-port.js";
import type { ThreadedInbox } from "../loop/threaded-inbox.js";
import type { ChildRunRegistry } from "../loop/turn-runner.js";
import { appendSubagentActivityBestEffort } from "./activity-event.js";

export interface ChildDriveInput {
  parentThread: Thread;
  parentTurnId: TurnId;
  prompt: string;
  budget: TreeBudget;
}

export type PreparedChild = {
  child: Thread;
  /** Server-assigned project handle (`pN`/`cN`); guaranteed non-null once prepared. */
  handle: string;
  /** Event/thread-visible slug; a named roster name or the generic subagent label. */
  resolvedSlug: string;
  /** Delivery-card title for a background spawn; omitted for continue. */
  description?: string;
  childController: AbortController;
  childRegistered: boolean;
  runLease: Lease;
  background: boolean;
  /** Spawn creates the child lifecycle; a message never rewrites it. */
  origin: "spawn" | "message";
};

export type ChildTerminal =
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; message: string; code: string };

export interface ChildRunDriverDeps {
  orchestrator: RunTurnPort;
  repos: {
    threads: Pick<ThreadRepository, "updateSpawnLifecycle">;
    turns: Pick<TurnRepository, "listByThread">;
    blocks: Pick<BlockRepository, "listByTurn">;
    transaction: ThreadRepositories["transaction"];
  };
  eventWriter: EventJournalWriter;
  /** Recomputes a run tree's activity; feeds the root-journal `subagent.activity` fact. */
  readActivity: (threadId: ThreadId) => Promise<ThreadActivity>;
  childRunRegistry: ChildRunRegistry;
  /** Producer-facing inbox: a background child's report is enqueued as a message. */
  threadedInbox: Pick<ThreadedInbox, "enqueue">;
  workContextDelivery: Pick<WorkContextDelivery, "flushOwned">;
  runAuthority: RunAuthority;
  billingSpendReader: BillingSpendReader;
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
  driveBackground(prepared: PreparedChild, input: ChildDriveInput): void;
}

export type ResolvedSpawn = {
  terminalStatus: "succeeded" | "failed" | "cancelled";
  spawnResult: SpawnResult;
};

/** One report shape for live capture, terminal fold, and synthesized fallback. */
export function buildAgentReport(input: {
  handle: string;
  threadId: string;
  capture: ReturnResultCapture;
  costMillicredits: number;
  incomplete?: boolean;
}): AgentReport {
  return {
    handle: input.handle,
    threadId: input.threadId,
    summary: input.capture.summary,
    ...(input.capture.payload !== undefined ? { payload: input.capture.payload } : {}),
    ...(input.capture.artifacts !== undefined ? { artifacts: input.capture.artifacts } : {}),
    costMillicredits: input.costMillicredits,
    ...(input.incomplete !== undefined ? { incomplete: input.incomplete } : {}),
  };
}

/**
 * The terminal→result cascade, pure but for the caller-provided incomplete
 * report. `captured` wins; then cancelled, error, completed-without-capture
 * (which the caller synthesizes), and finally a missing terminal event.
 */
export function resolveSpawnResult(input: {
  terminal: ChildTerminal | null;
  captured: ReturnResultCapture | undefined;
  handle: string;
  threadId: string;
  costMillicredits: number;
  incompleteReport?: AgentReport;
}): ResolvedSpawn {
  const { terminal, captured, handle, threadId, costMillicredits, incompleteReport } = input;
  if (captured) {
    return {
      terminalStatus: "succeeded",
      spawnResult: {
        status: "completed",
        report: buildAgentReport({ handle, threadId, capture: captured, costMillicredits }),
      },
    };
  }
  if (terminal?.type === "cancelled") {
    return {
      terminalStatus: "cancelled",
      spawnResult: {
        status: "error",
        error: meridianErrorFromSystem("spawn_cancelled", "Child run was cancelled"),
      },
    };
  }
  if (terminal?.type === "error") {
    return {
      terminalStatus: "failed",
      spawnResult: {
        status: "error",
        error: meridianErrorFromSystem(
          terminal.code || "spawn_failed",
          terminal.message || "Child run failed",
        ),
      },
    };
  }
  if (terminal?.type === "completed") {
    if (!incompleteReport) {
      throw new Error("resolveSpawnResult: completed terminal requires an incomplete report");
    }
    return {
      terminalStatus: "succeeded",
      spawnResult: { status: "completed", report: incompleteReport },
    };
  }
  return {
    terminalStatus: "failed",
    spawnResult: {
      status: "error",
      error: meridianErrorFromSystem("spawn_failed", "Child run ended without terminal event"),
    },
  };
}

async function synthesizeIncompleteReport(
  repos: ChildRunDriverDeps["repos"],
  childThreadId: ThreadId,
  handle: string,
  costMillicredits: number,
): Promise<AgentReport> {
  const turns = await repos.turns.listByThread(childThreadId);
  let summary = "Child run ended without return_result";
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role !== "assistant") continue;
    const blocks = await repos.blocks.listByTurn(turn.id);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block?.blockType !== "text") continue;
      const text = blockPlainText(block.blockType, block.content)?.trim();
      if (text) {
        summary = text;
        break;
      }
    }
    break;
  }
  return buildAgentReport({
    handle,
    threadId: childThreadId as string,
    capture: { summary },
    costMillicredits,
    incomplete: true,
  });
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
    if (handle === null) throw new Error("Prepared child has no concurrency handle");
    const childController = new AbortController();
    let runLease: Lease | null = null;
    try {
      runLease = await runAuthority.acquire(childThreadId, crypto.randomUUID());
      // Keep the id out: this message reaches the model as a tool error and
      // would put the child UUID back into re-emitted context.
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
          if (parentSignal.aborted) {
            childController.abort();
          } else {
            parentSignal.addEventListener("abort", () => childController.abort(), { once: true });
          }
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

  /** Releases a prepared child that never entered drive (e.g. a card write failed). */
  async function release(prepared: PreparedChild): Promise<void> {
    prepared.childController.abort();
    deps.childRunRegistry.unregisterChild(prepared.child.id as ThreadId);
    await runAuthority.release(prepared.runLease);
  }

  function appendBackgroundTerminal(
    prepared: PreparedChild,
    input: ChildDriveInput,
    result: SpawnResult,
  ): Promise<bigint> {
    if (result.status === "completed") {
      return deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
        type: "background.completed",
        parentThreadId: input.parentThread.id,
        parentTurnId: input.parentTurnId as string,
        childThreadId: prepared.child.id,
        agentSlug: prepared.resolvedSlug,
        result,
      });
    }
    return deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
      type: "background.failed",
      parentThreadId: input.parentThread.id,
      parentTurnId: input.parentTurnId as string,
      childThreadId: prepared.child.id,
      agentSlug: prepared.resolvedSlug,
      error: result.status === "error" ? result.error.message : "Background run failed",
    });
  }

  async function drive(prepared: PreparedChild, input: ChildDriveInput): Promise<SpawnResult> {
    let terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
    let spawnResult: SpawnResult = {
      status: "error",
      error: meridianErrorFromSystem("spawn_failed", "Child run did not produce a result"),
    };
    let reportId: TurnId | null = null;
    let captured: ReturnResultCapture | undefined;
    let capturedUsed = false;

    // Background reports are recorded durably the moment return_result settles,
    // not only in drive's terminal transaction, so a crash between the two
    // cannot lose the payload/artifacts; `enqueue` is idempotent on reportId.
    const enqueueBackgroundReport = async (result: SpawnResult) => {
      if (!prepared.background) return;
      const id = (reportId ?? crypto.randomUUID()) as TurnId;
      const artifacts = result.status === "completed" ? result.report.artifacts : undefined;
      const payload = result.status === "completed" ? result.report.payload : undefined;
      await deps.threadedInbox.enqueue({
        threadId: input.parentThread.id as ThreadId,
        intent: "message",
        provenance: { kind: "child", threadId: prepared.child.id as ThreadId, reportId: id },
        body: {
          kind: "report",
          text:
            result.status === "completed"
              ? result.report.summary
              : result.status === "error"
                ? result.error.message
                : "Background run finished.",
          ...(artifacts !== undefined ? { artifacts } : {}),
          ...(payload !== undefined ? { payload } : {}),
          ...(prepared.resolvedSlug ? { agentSlug: prepared.resolvedSlug } : {}),
          ...(prepared.description !== undefined ? { description: prepared.description } : {}),
          ...(result.status === "error" ? { failed: true } : {}),
        },
        idempotencyKey: `child-report:${id}`,
      });
    };

    const returnResultCompleter: ReturnResultCompleter = async (capture) => {
      if (capturedUsed) {
        return { ok: false, message: "return_result already called for this run" };
      }
      capturedUsed = true;
      captured = capture;
      if (reportId && prepared.background) {
        // Runs the moment the report is produced, before the child turn settles.
        await enqueueBackgroundReport({
          status: "completed",
          report: buildAgentReport({
            handle: prepared.handle,
            threadId: prepared.child.id,
            capture,
            costMillicredits: 0,
          }),
        });
      }
      return { ok: true };
    };

    try {
      const handle = await deps.orchestrator.runTurn({
        threadId: prepared.child.id as ThreadId,
        userText: input.prompt,
        signal: prepared.childController.signal,
        treeBudget: input.budget,
        isSubagentThread: true,
        returnResultCompleter,
        lease: prepared.runLease,
      });
      reportId = handle.assistantTurnId;
      deps.childRunRegistry.markChildTurn(
        prepared.child.id as ThreadId,
        handle.assistantTurnId as TurnId,
      );

      let childTerminal: ChildTerminal | null = null;
      for await (const event of handle.events) {
        if (event.type === "turn.completed") childTerminal = { type: "completed" };
        else if (event.type === "turn.cancelled") childTerminal = { type: "cancelled" };
        else if (event.type === "turn.error") {
          childTerminal = { type: "error", message: event.error.message, code: event.error.code };
        }
      }

      const childCostMillicredits = Number(
        await deps.billingSpendReader.getThreadDebitTotal({
          userId: input.parentThread.userId,
          threadId: prepared.child.id,
        }),
      );
      const incompleteReport =
        captured === undefined && childTerminal?.type === "completed"
          ? await synthesizeIncompleteReport(
              deps.repos,
              prepared.child.id as ThreadId,
              prepared.handle,
              childCostMillicredits,
            )
          : undefined;
      const resolved = resolveSpawnResult({
        terminal: childTerminal,
        captured,
        handle: prepared.handle,
        threadId: prepared.child.id,
        costMillicredits: childCostMillicredits,
        ...(incompleteReport !== undefined ? { incompleteReport } : {}),
      });
      terminalStatus = resolved.terminalStatus;
      spawnResult = resolved.spawnResult;
    } catch (error) {
      terminalStatus = "failed";
      const message = error instanceof Error ? error.message : String(error);
      spawnResult = { status: "error", error: meridianErrorFromSystem("spawn_failed", message) };
    } finally {
      try {
        await deps.repos.transaction(async () => {
          // spawn_status/spawn_result record the spawn; a continue run's outcome
          // lives on its per-execution card and events and never erases it.
          if (prepared.origin === "spawn") {
            await deps.repos.threads.updateSpawnLifecycle(prepared.child.id as ThreadId, {
              spawnStatus: terminalStatus,
              spawnResult,
            });
          }
          await deps.eventWriter.appendEvent(input.parentThread.id as ThreadId, {
            type: "agent.run_completed",
            parentThreadId: input.parentThread.id,
            parentTurnId: input.parentTurnId as string,
            childThreadId: prepared.child.id,
            result: spawnResult,
          });
          await enqueueBackgroundReport(spawnResult);
        });
      } finally {
        deps.childRunRegistry.abortChildrenOf(prepared.child.id as ThreadId, {
          includeBackground: true,
        });
        try {
          if (prepared.childRegistered) {
            try {
              await deps.workContextDelivery.flushOwned(prepared.child.id as ThreadId);
            } finally {
              deps.childRunRegistry.unregisterChild(prepared.child.id as ThreadId);
            }
          }
        } finally {
          await runAuthority.release(prepared.runLease);
        }
      }
    }

    // After the lease release so the node reads terminal/asleep, not awake.
    // Best-effort: the run's outcome is already durable above; a read-model
    // failure must not become a `background.failed` or a failed spawn result.
    await appendSubagentActivityBestEffort({
      eventWriter: deps.eventWriter,
      readActivity: deps.readActivity,
      rootThreadId: input.parentThread.rootThreadId as ThreadId,
      childThreadId: prepared.child.id,
      eventSink: deps.eventSink,
    });

    return spawnResult;
  }

  function driveBackground(prepared: PreparedChild, input: ChildDriveInput): void {
    void drive(prepared, input)
      .then((result) => appendBackgroundTerminal(prepared, input, result))
      .catch((error: unknown) =>
        appendBackgroundTerminal(prepared, input, {
          status: "error",
          error: meridianErrorFromSystem(
            "spawn_failed",
            error instanceof Error ? error.message : String(error),
          ),
        }),
      );
  }

  return { register, release, drive, driveBackground };
}
