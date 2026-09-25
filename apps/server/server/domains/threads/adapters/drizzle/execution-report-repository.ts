/** Durable per-assistant-turn execution reports and publication obligations. */

import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, getTableColumns, gt, isNull, or, sql } from "drizzle-orm";
import { assertExecutionReportAdmission } from "../../domain/execution-report-admission.js";
import {
  assertReportCapture,
  assertReportIdentity,
  assertReportTerminal,
  decodeReportCapture,
  reportCapture,
  reportIdentity,
  reportPublicationByDelivery,
  reportTerminalContent,
  reportTerminalSchema,
} from "../../domain/execution-report-state.js";
import type {
  AdmitExecutionReportInput,
  ExecutionReportRepository,
  FinalizeExecutionReportInput,
} from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

type ExecutionReportRow = Omit<
  typeof schema.threadExecutionReports.$inferSelect,
  "payload" | "capture"
> & {
  capture: string | null;
  payload: string | null;
};

function map(row: ExecutionReportRow): SavedExecutionReport {
  // Read PostgreSQL's serialization so the driver and Drizzle cannot reinterpret
  // a JSON scalar string as the JSON text it happens to contain.
  return {
    childThreadId: row.childThreadId,
    assistantTurnId: row.assistantTurnId,
    terminalAssistantTurnId: row.terminalAssistantTurnId,
    handle: row.handle,
    origin: row.origin as SavedExecutionReport["origin"],
    deliveryMode: row.deliveryMode as SavedExecutionReport["deliveryMode"],
    callerThreadId: row.callerThreadId,
    callerTurnId: row.callerTurnId,
    toolCallId: row.toolCallId,
    cardBlockId: row.cardBlockId,
    agentSlug: row.agentSlug,
    description: row.description,
    capture: row.capture === null ? null : decodeReportCapture(JSON.parse(row.capture)),
    captureToolCallId: row.captureToolCallId,
    ...reportTerminalSchema.parse({ ...row, terminalAt: row.terminalAt?.toISOString() ?? null }),
    reason: row.reason,
    ...(row.payload !== null ? { payload: JSON.parse(row.payload) } : {}),
    artifacts: row.artifacts as ArtifactRef[] | null,
    costMillicredits: row.costMillicredits,
    publication: row.publication as SavedExecutionReport["publication"],
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export function createDrizzleExecutionReportRepository(db: DrizzleDb): ExecutionReportRepository {
  const table = schema.threadExecutionReports;
  const reportSelection = {
    ...getTableColumns(table),
    payload: sql<string | null>`${table.payload}::text`,
    capture: sql<string | null>`${table.capture}::text`,
  };
  const find = async (childThreadId: string, assistantTurnId: string) => {
    const [row] = await currentDrizzleDb(db)
      .select(reportSelection)
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
    async findByTurn(childThreadId, turnId) {
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE chain AS (
          SELECT id, parent_turn_id, 0 AS depth FROM turns
          WHERE id = ${turnId} AND thread_id = ${childThreadId}
          UNION ALL
          SELECT t.id, t.parent_turn_id, chain.depth + 1 FROM turns t
          JOIN chain ON t.id = chain.parent_turn_id
          WHERE t.thread_id = ${childThreadId}
        )
        SELECT r.assistant_turn_id FROM chain
        JOIN thread_execution_reports r ON r.assistant_turn_id = chain.id
        WHERE r.child_thread_id = ${childThreadId}
        ORDER BY chain.depth LIMIT 1
      `);
      const id = rows[0]?.assistant_turn_id as string | undefined;
      const row = id ? await find(childThreadId, id) : null;
      return row ? map(row) : null;
    },
    async admit(input: AdmitExecutionReportInput) {
      const database = currentDrizzleDb(db);
      const [child] = await database
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, input.childThreadId))
        .limit(1);
      const [assistant] = await database
        .select({
          id: schema.turns.id,
          threadId: schema.turns.threadId,
          role: schema.turns.role,
        })
        .from(schema.turns)
        .where(eq(schema.turns.id, input.assistantTurnId))
        .limit(1);
      const [caller] = input.callerThreadId
        ? await database
            .select()
            .from(schema.threads)
            .where(eq(schema.threads.id, input.callerThreadId))
            .limit(1)
        : [];
      const [callerTurn] = input.callerTurnId
        ? await database
            .select({
              id: schema.turns.id,
              threadId: schema.turns.threadId,
              role: schema.turns.role,
            })
            .from(schema.turns)
            .where(eq(schema.turns.id, input.callerTurnId))
            .limit(1)
        : [];
      const [card] = input.cardBlockId
        ? await database
            .select({
              turnId: schema.turnBlocks.turnId,
              blockType: schema.turnBlocks.blockType,
            })
            .from(schema.turnBlocks)
            .where(eq(schema.turnBlocks.id, input.cardBlockId))
            .limit(1)
        : [];
      assertExecutionReportAdmission(input, {
        child: child ? { ...child, userId: child.createdByUserId } : null,
        assistant: assistant ?? null,
        caller: caller ? { ...caller, userId: caller.createdByUserId } : null,
        callerTurn: callerTurn ?? null,
        card: card ?? null,
      });
      const values = reportIdentity(input);
      await currentDrizzleDb(db).insert(table).values(values).onConflictDoNothing();
      const row = await find(input.childThreadId, input.assistantTurnId);
      if (!row) throw new Error("Execution report admission did not persist");
      const report = map(row);
      assertReportIdentity(report, values);
      return report;
    },
    async captureOnce(childThreadId, assistantTurnId, toolCallId, capture) {
      const candidate = reportCapture(capture);
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
        .returning(reportSelection);
      const existing = row ?? (await find(childThreadId, assistantTurnId));
      if (!existing) throw new Error("Execution report was not admitted");
      const report = map(existing);
      assertReportCapture(report, toolCallId, candidate);
      return report;
    },
    async finalizeOnce(input: FinalizeExecutionReportInput) {
      const content = reportTerminalContent(input);
      const values = {
        ...content,
        payload:
          input.payload === undefined
            ? null
            : input.payload === null
              ? sql`'null'::jsonb`
              : input.payload,
        terminalAt: new Date(),
      };
      const [row] = await currentDrizzleDb(db)
        .update(table)
        .set({
          ...values,
          publication: sql`CASE ${table.deliveryMode} ${sql.join(
            Object.entries(reportPublicationByDelivery).map(
              ([mode, publication]) => sql`WHEN ${mode} THEN ${publication}`,
            ),
            sql.raw(" "),
          )} END`,
        })
        .where(
          and(
            eq(table.childThreadId, input.childThreadId),
            eq(table.assistantTurnId, input.assistantTurnId),
            isNull(table.outcome),
          ),
        )
        .returning(reportSelection);
      const existing = row ?? (await find(input.childThreadId, input.assistantTurnId));
      if (!existing) throw new Error("Execution report was not admitted");
      const report = map(existing);
      assertReportTerminal(report, content);
      return report;
    },
    async findByExecution(childThreadId, assistantTurnId) {
      const row = await find(childThreadId, assistantTurnId);
      return row ? map(row) : null;
    },
    async listUnfinalized(limit, afterExecutionId) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Limit must be positive");
      return currentDrizzleDb(db)
        .select({
          childThreadId: table.childThreadId,
          assistantTurnId: table.assistantTurnId,
        })
        .from(table)
        .where(
          and(
            isNull(table.outcome),
            ...(afterExecutionId ? [gt(table.assistantTurnId, afterExecutionId)] : []),
          ),
        )
        .orderBy(asc(table.assistantTurnId))
        .limit(limit);
    },
    async listPendingPublication(limit, afterExecutionId) {
      const caller = schema.threads;
      const rows = await currentDrizzleDb(db)
        .select({
          childThreadId: table.childThreadId,
          assistantTurnId: table.assistantTurnId,
          callerThreadId: table.callerThreadId,
        })
        .from(table)
        .leftJoin(caller, eq(caller.id, table.callerThreadId))
        .leftJoin(schema.projects, eq(schema.projects.id, caller.projectId))
        .where(
          and(
            eq(table.publication, "pending"),
            ...(afterExecutionId ? [gt(table.assistantTurnId, afterExecutionId)] : []),
            or(
              isNull(table.callerThreadId),
              and(isNull(caller.deletedAt), isNull(schema.projects.deletedAt)),
            ),
          ),
        )
        .orderBy(asc(table.assistantTurnId))
        .limit(limit);
      return rows;
    },
    async lockPendingPublication(childThreadId, assistantTurnId) {
      const [row] = await currentDrizzleDb(db)
        .select(reportSelection)
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
