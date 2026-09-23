/** Durable per-assistant-turn execution reports and publication obligations. */

import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type {
  AdmitExecutionReportInput,
  ExecutionReportRepository,
  FinalizeExecutionReportInput,
} from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

function map(row: typeof schema.threadExecutionReports.$inferSelect): SavedExecutionReport {
  return {
    childThreadId: row.childThreadId,
    assistantTurnId: row.assistantTurnId,
    handle: row.handle,
    origin: row.origin as SavedExecutionReport["origin"],
    deliveryMode: row.deliveryMode as SavedExecutionReport["deliveryMode"],
    callerThreadId: row.callerThreadId,
    callerTurnId: row.callerTurnId,
    toolCallId: row.toolCallId,
    cardBlockId: row.cardBlockId,
    agentSlug: row.agentSlug,
    description: row.description,
    capture: row.capture,
    captureToolCallId: row.captureToolCallId,
    outcome: row.outcome as SavedExecutionReport["outcome"],
    reason: row.reason,
    source: row.source as SavedExecutionReport["source"],
    summary: row.summary,
    payload: row.payload,
    artifacts: row.artifacts as ArtifactRef[] | null,
    costMillicredits: row.costMillicredits,
    terminalAt: row.terminalAt?.toISOString() ?? null,
    publication: row.publication as SavedExecutionReport["publication"],
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export class ExecutionReportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionReportConflictError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createDrizzleExecutionReportRepository(db: DrizzleDb): ExecutionReportRepository {
  const table = schema.threadExecutionReports;
  const find = async (childThreadId: string, assistantTurnId: string) => {
    const [row] = await currentDrizzleDb(db)
      .select()
      .from(table)
      .where(
        and(
          eq(table.childThreadId, childThreadId as never),
          eq(table.assistantTurnId, assistantTurnId as never),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  return {
    async admit(input: AdmitExecutionReportInput) {
      const [turn] = await currentDrizzleDb(db)
        .select({ role: schema.turns.role })
        .from(schema.turns)
        .where(
          and(
            eq(schema.turns.id, input.assistantTurnId),
            eq(schema.turns.threadId, input.childThreadId),
          ),
        )
        .limit(1);
      if (turn?.role !== "assistant")
        throw new Error("Execution reports require an admitted child assistant turn");
      const values = {
        assistantTurnId: input.assistantTurnId,
        childThreadId: input.childThreadId,
        handle: input.handle,
        origin: input.origin,
        deliveryMode: input.deliveryMode,
        callerThreadId: input.callerThreadId,
        callerTurnId: input.callerTurnId,
        toolCallId: input.toolCallId,
        cardBlockId: input.cardBlockId,
        agentSlug: input.agentSlug ?? null,
        description: input.description ?? null,
      };
      await currentDrizzleDb(db).insert(table).values(values).onConflictDoNothing();
      const row = await find(input.childThreadId, input.assistantTurnId);
      if (!row) throw new Error("Execution report admission did not persist");
      for (const [key, value] of Object.entries(values)) {
        if (row[key as keyof typeof row] !== value)
          throw new ExecutionReportConflictError("Conflicting execution report admission");
      }
      return map(row);
    },
    async captureOnce(childThreadId, assistantTurnId, toolCallId, capture) {
      const candidate = {
        summary: capture.summary,
        ...(capture.payload !== undefined ? { payload: capture.payload } : {}),
        ...(capture.artifacts !== undefined ? { artifacts: capture.artifacts } : {}),
      };
      const [row] = await currentDrizzleDb(db)
        .update(table)
        .set({ capture: candidate, captureToolCallId: toolCallId })
        .where(
          and(
            eq(table.childThreadId, childThreadId),
            eq(table.assistantTurnId, assistantTurnId),
            isNull(table.capture),
            isNull(table.outcome),
          ),
        )
        .returning();
      const existing = row ?? (await find(childThreadId, assistantTurnId));
      if (!existing) throw new Error("Execution report was not admitted");
      if (
        existing.captureToolCallId !== toolCallId ||
        canonical(existing.capture) !== canonical(candidate)
      )
        throw new ExecutionReportConflictError("A different return_result was already accepted");
      return map(existing);
    },
    async finalizeOnce(input: FinalizeExecutionReportInput) {
      const values = {
        outcome: input.outcome,
        reason: input.reason,
        source: input.source,
        summary: input.summary,
        payload: input.payload ?? null,
        artifacts: input.artifacts ?? null,
        costMillicredits: input.costMillicredits ?? null,
        terminalAt: new Date(),
        publication: input.publication ?? "none",
      };
      const [row] = await currentDrizzleDb(db)
        .update(table)
        .set(values)
        .where(
          and(
            eq(table.childThreadId, input.childThreadId),
            eq(table.assistantTurnId, input.assistantTurnId),
            isNull(table.outcome),
          ),
        )
        .returning();
      const existing = row ?? (await find(input.childThreadId, input.assistantTurnId));
      if (!existing) throw new Error("Execution report was not admitted");
      const same =
        existing.outcome === values.outcome &&
        existing.reason === values.reason &&
        existing.source === values.source &&
        existing.summary === values.summary &&
        canonical(existing.payload) === canonical(values.payload) &&
        canonical(existing.artifacts) === canonical(values.artifacts) &&
        existing.costMillicredits === values.costMillicredits;
      if (!same)
        throw new ExecutionReportConflictError(
          "Execution report already has a conflicting terminal outcome",
        );
      return map(existing);
    },
    async findByExecution(childThreadId, assistantTurnId) {
      const row = await find(childThreadId, assistantTurnId);
      return row ? map(row) : null;
    },
    async listPendingPublication(limit) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(table)
        .where(eq(table.publication, "pending"))
        .orderBy(asc(table.createdAt))
        .limit(limit);
      return rows.map(map);
    },
    async lockPendingPublication(childThreadId, assistantTurnId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(table)
        .where(
          and(
            eq(table.childThreadId, childThreadId),
            eq(table.assistantTurnId, assistantTurnId),
            eq(table.publication, "pending"),
          ),
        )
        .for("update")
        .limit(1);
      return row ? map(row) : null;
    },
    async markPublished(childThreadId, assistantTurnId, publication) {
      await currentDrizzleDb(db)
        .update(table)
        .set({ publication, publishedAt: new Date() })
        .where(
          and(
            eq(table.childThreadId, childThreadId),
            eq(table.assistantTurnId, assistantTurnId),
            eq(table.publication, "pending"),
          ),
        );
    },
  };
}
