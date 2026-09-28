/** Bounded crash repair for admitted child turns without terminal truth. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isPlaceholderRole, isTerminalTurnStatus } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter, ThreadRepositories } from "../../threads/index.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import { finalizeOrphanedPlaceholder } from "../loop/orphaned-placeholder.js";
import type { RunClaim } from "../loop/ports.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import type { ReportPublisher } from "./report-publisher.js";

export function createOrphanReportRepair(deps: {
  repos: ThreadRepositories;
  inbox: Pick<import("../loop/ports.js").InboxReader, "selectPending">;
  eventWriter: EventJournalWriter;
  authority: RunClaim;
  threadLock: ThreadLock;
  publisher: Pick<ReportPublisher, "publish">;
  eventSink: EventSink;
}) {
  let reportCursor: TurnId | undefined;
  let placeholderCursor: TurnId | undefined;

  async function repairReport(childThreadId: ThreadId, executionTurnId: TurnId): Promise<void> {
    const reportsToPublish = new Map<TurnId, SavedExecutionReport>();
    await deps.authority.withExclusiveThread(childThreadId, async () => {
      await deps.threadLock.withThreadLock(childThreadId, async () => {
        const report = await deps.repos.executionReports.findByExecution(
          childThreadId,
          executionTurnId,
        );
        if (!report || report.outcome !== null) return;

        const placeholderReports = await finalizeOrphanedPlaceholder(deps, {
          threadId: childThreadId,
        });
        for (const report of placeholderReports)
          reportsToPublish.set(report.executionTurnId, report);
        if (placeholderReports.some((report) => report.executionTurnId === executionTurnId)) return;

        const turns = await deps.repos.turns.listByThread(childThreadId);
        let terminal = turns.find((candidate) => candidate.id === executionTurnId);
        let leaf = terminal;
        while (leaf) {
          const next = turns.find((candidate) => candidate.parentTurnId === leaf?.id);
          if (!next) break;
          // Every admitted selector begins a separate execution, regardless of turn role.
          if (await deps.repos.executionReports.findByExecution(childThreadId, next.id)) break;
          leaf = next;
          if (next.role === "assistant" || isPlaceholderRole(next.role)) terminal = next;
        }
        if (
          !terminal ||
          (terminal.role !== "assistant" && !isPlaceholderRole(terminal.role)) ||
          isTerminalTurnStatus(terminal.status)
        )
          return;

        const completion = await finalizeExecution(deps, {
          threadId: childThreadId,
          turnId: terminal.id,
          cause: {
            kind: "failed",
            reason: "orphaned",
            error: "Child execution stopped before terminal completion",
          },
        });
        if (completion.report)
          reportsToPublish.set(completion.report.executionTurnId, completion.report);
      });
    });
    for (const report of reportsToPublish.values())
      await deps.publisher.publish(report.childThreadId, report.executionTurnId);
  }

  async function repairPlaceholder(candidate: { threadId: ThreadId; id: TurnId }): Promise<void> {
    const reports = await deps.authority.withExclusiveThread(candidate.threadId, () =>
      deps.threadLock.withThreadLock(candidate.threadId, () =>
        finalizeOrphanedPlaceholder(deps, { threadId: candidate.threadId }),
      ),
    );
    for (const report of reports ?? [])
      await deps.publisher.publish(report.childThreadId, report.executionTurnId);
  }

  async function sweep(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Repair limit must be positive");

    let placeholders = await deps.repos.turns.listPendingPlaceholders(limit, placeholderCursor);
    if (placeholders.length === 0 && placeholderCursor) {
      placeholderCursor = undefined;
      placeholders = await deps.repos.turns.listPendingPlaceholders(limit);
    }
    for (const candidate of placeholders) {
      placeholderCursor = candidate.id;
      try {
        await repairPlaceholder({ threadId: candidate.threadId, id: candidate.id });
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.report-repair",
          name: "placeholder.failed",
          correlation: { threadId: candidate.threadId, turnId: candidate.id },
          payload: unknownToEventPayload(error),
        });
      }
    }

    let reports = await deps.repos.executionReports.listUnfinalized(limit, reportCursor);
    if (reports.length === 0 && reportCursor) {
      reportCursor = undefined;
      reports = await deps.repos.executionReports.listUnfinalized(limit);
    }
    for (const candidate of reports) {
      reportCursor = candidate.executionTurnId;
      try {
        await repairReport(candidate.childThreadId, candidate.executionTurnId);
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.report-repair",
          name: "repair.failed",
          correlation: { threadId: candidate.childThreadId, turnId: candidate.executionTurnId },
          payload: unknownToEventPayload(error),
        });
      }
    }
    return placeholders.length + reports.length;
  }

  return { sweep };
}
