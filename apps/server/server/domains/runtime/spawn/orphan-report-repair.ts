/** Bounded crash repair for admitted child turns without terminal truth. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter, ThreadRepositories } from "../../threads/index.js";
import { finalizeExecution } from "../loop/execution-finalizer.js";
import type { RunAuthority } from "../loop/ports.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import type { ReportPublisher } from "./report-publisher.js";

export function createOrphanReportRepair(deps: {
  repos: ThreadRepositories;
  eventWriter: EventJournalWriter;
  authority: RunAuthority;
  threadLock: ThreadLock;
  publisher: Pick<ReportPublisher, "publish">;
  eventSink: EventSink;
}) {
  let cursor: TurnId | undefined;

  async function repair(childThreadId: ThreadId, assistantTurnId: TurnId): Promise<void> {
    // A missing/expired lease row is not evidence of death. Only the real
    // per-thread session claim can establish that no runner still owns it.
    const claim = await deps.authority.acquire(childThreadId, crypto.randomUUID());
    if (!claim) return;
    let finalized = false;
    try {
      await deps.threadLock.withThreadLock(childThreadId, async () => {
        const report = await deps.repos.executionReports.findByExecution(
          childThreadId,
          assistantTurnId,
        );
        const turns = await deps.repos.turns.listByThread(childThreadId);
        let turn = turns.find((candidate) => candidate.id === assistantTurnId);
        let leaf = turn;
        while (leaf) {
          const next = turns.find((candidate) => candidate.parentTurnId === leaf?.id);
          if (!next) break;
          if (
            next.role === "assistant" &&
            (await deps.repos.executionReports.findByExecution(childThreadId, next.id))
          )
            break;
          leaf = next;
          if (next.role === "assistant") turn = next;
        }
        if (
          !report ||
          report.outcome !== null ||
          !turn ||
          turn.role !== "assistant" ||
          isTerminalTurnStatus(turn.status)
        )
          return;
        await finalizeExecution(
          { repos: deps.repos, eventWriter: deps.eventWriter },
          {
            threadId: childThreadId,
            assistantTurnId: turn.id,
            cause: {
              kind: "failed",
              reason: "orphaned",
              error: "Child execution stopped before terminal completion",
            },
          },
        );
        finalized = true;
      });
    } finally {
      await deps.authority.release(claim);
    }
    if (finalized) await deps.publisher.publish(childThreadId, assistantTurnId);
  }

  async function sweep(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Repair limit must be positive");
    let candidates = await deps.repos.executionReports.listUnfinalized(limit, cursor);
    if (candidates.length === 0 && cursor) {
      cursor = undefined;
      candidates = await deps.repos.executionReports.listUnfinalized(limit);
    }
    for (const candidate of candidates) {
      cursor = candidate.assistantTurnId;
      try {
        await repair(candidate.childThreadId, candidate.assistantTurnId);
      } catch (error) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.report-repair",
          name: "repair.failed",
          correlation: { threadId: candidate.childThreadId, turnId: candidate.assistantTurnId },
          payload: unknownToEventPayload(error),
        });
      }
    }
    return candidates.length;
  }

  return { sweep };
}
