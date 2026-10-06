/** Transactional in-memory execution reports with the same admission and CAS contract as PostgreSQL. */
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import type { InMemoryTransactionOwner } from "../../../../shared/in-memory-transaction.js";
import { assertExecutionReportAdmission } from "../../domain/execution-report-admission.js";
import { ExecutionReportConflictError } from "../../domain/execution-report-conflict.js";
import {
  assertReportCapture,
  assertReportIdentity,
  assertReportTerminal,
  reportCapture,
  reportIdentity,
  reportPublicationByDelivery,
  reportTerminalContent,
} from "../../domain/execution-report-state.js";
import type { ExecutionReportRepository } from "../../ports/repositories.js";

export function createInMemoryExecutionReportRepository(
  owner: InMemoryTransactionOwner,
  deps: {
    threads: Map<string, Thread>;
    turns: Map<string, Turn>;
    blocks: Map<string, Block>;
    projects?: { findById(id: string): Promise<{ deletedAt: string | null } | null> };
  },
): ExecutionReportRepository {
  const rows = owner.map<string, SavedExecutionReport>();
  const find = (child: string, execution: string) => {
    const row = rows.get(execution);
    return row?.childThreadId === child ? row : null;
  };
  const positionForReport = (executionTurnId: string) => {
    const turn = deps.turns.get(executionTurnId);
    if (!turn) throw new Error(`Execution report turn not found: ${executionTurnId}`);
    return turn.position;
  };
  return {
    async findByTurn(child, turnId) {
      let turn = deps.turns.get(turnId);
      while (turn?.threadId === child) {
        const report = find(child, turn.id);
        if (report) return report;
        turn = turn.parentTurnId ? deps.turns.get(turn.parentTurnId) : undefined;
      }
      return null;
    },
    async admit(input) {
      assertExecutionReportAdmission(input, {
        child: deps.threads.get(input.childThreadId) ?? null,
        assistant: deps.turns.get(input.executionTurnId) ?? null,
        caller: input.callerThreadId ? (deps.threads.get(input.callerThreadId) ?? null) : null,
        callerTurn: input.callerTurnId ? (deps.turns.get(input.callerTurnId) ?? null) : null,
        card: input.cardBlockId ? (deps.blocks.get(input.cardBlockId) ?? null) : null,
      });
      const existing = rows.get(input.executionTurnId);
      const identity = reportIdentity(input);
      if (existing) {
        assertReportIdentity(existing, identity);
        return existing;
      }
      const row: SavedExecutionReport = {
        ...identity,
        admittedAt: new Date().toISOString(),
        terminalTurnId: null,
        capture: null,
        captureToolCallId: null,
        outcome: null,
        reason: null,
        source: null,
        summary: null,
        artifacts: null,
        costMillicredits: null,
        terminalAt: null,
        publication: "none",
        publishedAt: null,
      };
      rows.set(input.executionTurnId, row);
      return row;
    },
    async captureOnce(child, execution, toolCallId, capture) {
      const row = find(child, execution);
      if (!row) throw new Error("Execution report was not admitted");
      const candidate = reportCapture(capture);
      if (row.capture !== null) {
        assertReportCapture(row, toolCallId, candidate);
        return row;
      }
      if (row.outcome !== null)
        throw new ExecutionReportConflictError(
          "Cannot capture a report after terminal finalization",
        );
      const next = { ...row, capture: candidate, captureToolCallId: toolCallId };
      rows.set(execution, next);
      return next;
    },
    async finalizeOnce(input) {
      const row = find(input.childThreadId, input.executionTurnId);
      if (!row) throw new Error("Execution report was not admitted");
      const content = reportTerminalContent(input);
      if (row.outcome !== null) {
        assertReportTerminal(row, content);
        return row;
      }
      const next: SavedExecutionReport = {
        ...row,
        ...content,
        terminalAt: new Date().toISOString(),
        publication: reportPublicationByDelivery[row.deliveryMode],
      };
      rows.set(input.executionTurnId, next);
      return next;
    },
    async findByExecution(child, execution) {
      return find(child, execution);
    },
    async listLatestByChildren(childThreadIds) {
      const childIds = new Set(childThreadIds);
      const latest = new Map<string, SavedExecutionReport>();
      for (const row of rows.values()) {
        if (!childIds.has(row.childThreadId)) continue;
        const current = latest.get(row.childThreadId);
        if (
          !current ||
          row.admittedAt > current.admittedAt ||
          (row.admittedAt === current.admittedAt && row.executionTurnId > current.executionTurnId)
        ) {
          latest.set(row.childThreadId, row);
        }
      }
      return [...latest.values()].map(
        ({ childThreadId, deliveryMode, callerThreadId, admittedAt, terminalAt }) => ({
          childThreadId,
          deliveryMode,
          callerThreadId,
          admittedAt,
          terminalAt,
        }),
      );
    },
    async listFinishedByChild(child) {
      return [...rows.values()]
        .filter((row) => row.childThreadId === child && row.outcome !== null)
        .sort(
          (a, b) =>
            positionForReport(a.executionTurnId) - positionForReport(b.executionTurnId) ||
            a.executionTurnId.localeCompare(b.executionTurnId),
        );
    },
    async listUnfinalized(limit, afterExecutionId) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Limit must be positive");
      return [...rows.values()]
        .filter(
          (row) =>
            row.outcome === null && (!afterExecutionId || row.executionTurnId > afterExecutionId),
        )
        .sort((a, b) => a.executionTurnId.localeCompare(b.executionTurnId))
        .slice(0, limit)
        .map(({ childThreadId, executionTurnId }) => ({ childThreadId, executionTurnId }));
    },
    async listPendingPublication(limit, afterExecutionId) {
      const eligible = [];
      for (const row of rows.values()) {
        if (row.publication !== "pending") continue;
        if (afterExecutionId && row.executionTurnId <= afterExecutionId) continue;
        if (!row.callerThreadId) {
          throw new Error("Pending publication violates caller-thread invariant");
        }
        const caller = deps.threads.get(row.callerThreadId);
        if (!caller) {
          throw new Error("Pending publication violates caller-thread invariant");
        }
        if (caller.deletedAt) continue;
        if (deps.projects) {
          const project = await deps.projects.findById(caller.projectId);
          if (project?.deletedAt) continue;
        }
        eligible.push({
          childThreadId: row.childThreadId,
          executionTurnId: row.executionTurnId,
          callerThreadId: caller.id,
        });
      }
      eligible.sort((a, b) => a.executionTurnId.localeCompare(b.executionTurnId));
      return eligible.slice(0, limit).map(({ childThreadId, executionTurnId, callerThreadId }) => ({
        childThreadId,
        executionTurnId,
        callerThreadId,
      }));
    },
    async lockPendingPublication(child, execution) {
      const row = find(child, execution);
      return row?.publication === "pending" ? row : null;
    },
    async markPublished(child, execution, publication) {
      const row = find(child, execution);
      if (row?.publication === "pending")
        rows.set(execution, {
          ...row,
          publication,
          publishedAt: new Date().toISOString(),
        });
    },
  };
}
