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
  return {
    async admit(input) {
      assertExecutionReportAdmission(input, {
        child: deps.threads.get(input.childThreadId) ?? null,
        assistant: deps.turns.get(input.assistantTurnId) ?? null,
        caller: input.callerThreadId ? (deps.threads.get(input.callerThreadId) ?? null) : null,
        callerTurn: input.callerTurnId ? (deps.turns.get(input.callerTurnId) ?? null) : null,
        card: input.cardBlockId ? (deps.blocks.get(input.cardBlockId) ?? null) : null,
      });
      const existing = rows.get(input.assistantTurnId);
      const identity = reportIdentity(input);
      if (existing) {
        assertReportIdentity(existing, identity);
        return existing;
      }
      const row: SavedExecutionReport = {
        ...identity,
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
      rows.set(input.assistantTurnId, row);
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
      const row = find(input.childThreadId, input.assistantTurnId);
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
      rows.set(input.assistantTurnId, next);
      return next;
    },
    async findByExecution(child, execution) {
      return find(child, execution);
    },
    async listUnfinalized(limit, afterExecutionId) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Limit must be positive");
      return [...rows.values()]
        .filter(
          (row) =>
            row.outcome === null && (!afterExecutionId || row.assistantTurnId > afterExecutionId),
        )
        .sort((a, b) => a.assistantTurnId.localeCompare(b.assistantTurnId))
        .slice(0, limit)
        .map(({ childThreadId, assistantTurnId }) => ({ childThreadId, assistantTurnId }));
    },
    async listPendingPublication(limit, afterExecutionId) {
      const eligible = [];
      for (const row of rows.values()) {
        if (row.publication !== "pending") continue;
        if (afterExecutionId && row.assistantTurnId <= afterExecutionId) continue;
        const caller = row.callerThreadId ? deps.threads.get(row.callerThreadId) : null;
        if (caller?.deletedAt) continue;
        if (caller && deps.projects) {
          const project = await deps.projects.findById(caller.projectId);
          if (project?.deletedAt) continue;
        }
        eligible.push({
          childThreadId: row.childThreadId,
          assistantTurnId: row.assistantTurnId,
          callerThreadId: caller?.id ?? null,
        });
      }
      eligible.sort((a, b) => a.assistantTurnId.localeCompare(b.assistantTurnId));
      return eligible.slice(0, limit).map(({ childThreadId, assistantTurnId, callerThreadId }) => ({
        childThreadId,
        assistantTurnId,
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
