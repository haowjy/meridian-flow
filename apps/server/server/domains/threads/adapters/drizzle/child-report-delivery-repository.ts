/** Drizzle persistence for durable child-report delivery obligations. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type {
  ChildReportDeliveryObligation,
  ChildReportDeliveryRepository,
  EnqueueChildReportDeliveryInput,
} from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

function toObligation(
  row: typeof schema.childReportDeliveries.$inferSelect,
): ChildReportDeliveryObligation {
  return {
    reportId: row.reportId as TurnId,
    parentThreadId: row.parentThreadId as ThreadId,
    childThreadId: row.childThreadId as ThreadId,
    agentSlug: row.agentSlug,
    description: row.description,
    result: row.result as SpawnResult,
    systemTurnId: row.systemTurnId as TurnId | null,
    submissionEpoch: row.submissionEpoch,
  };
}

export function createDrizzleChildReportDeliveryRepository(
  db: DrizzleDatabase,
): ChildReportDeliveryRepository {
  return {
    async enqueue(input: EnqueueChildReportDeliveryInput) {
      await currentDrizzleDb(db)
        .insert(schema.childReportDeliveries)
        .values({
          reportId: input.reportId,
          parentThreadId: input.parentThreadId,
          childThreadId: input.childThreadId,
          agentSlug: input.agentSlug,
          description: input.description ?? null,
          result: input.result,
          systemTurnId: input.systemTurnId ?? null,
        })
        .onConflictDoNothing({ target: schema.childReportDeliveries.reportId });
    },

    async listPendingParentThreadIds() {
      const rows = await currentDrizzleDb(db)
        .selectDistinct({ parentThreadId: schema.childReportDeliveries.parentThreadId })
        .from(schema.childReportDeliveries);
      return rows.map(({ parentThreadId }) => parentThreadId as ThreadId);
    },

    async listPendingByParent(parentThreadId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(schema.childReportDeliveries)
        .where(eq(schema.childReportDeliveries.parentThreadId, parentThreadId))
        .orderBy(asc(schema.childReportDeliveries.createdAt));
      return rows.map(toObligation);
    },

    async findByReportId(reportId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.childReportDeliveries)
        .where(eq(schema.childReportDeliveries.reportId, reportId))
        .limit(1);
      return row ? toObligation(row) : null;
    },

    async setSystemTurnId(reportId, systemTurnId) {
      await currentDrizzleDb(db)
        .update(schema.childReportDeliveries)
        .set({ systemTurnId })
        .where(
          and(
            eq(schema.childReportDeliveries.reportId, reportId),
            isNull(schema.childReportDeliveries.systemTurnId),
          ),
        );
    },

    async advanceEpoch(reportId) {
      await currentDrizzleDb(db)
        .update(schema.childReportDeliveries)
        .set({ submissionEpoch: sql`${schema.childReportDeliveries.submissionEpoch} + 1` })
        .where(eq(schema.childReportDeliveries.reportId, reportId));
    },

    async acknowledge(reportId) {
      await currentDrizzleDb(db)
        .delete(schema.childReportDeliveries)
        .where(eq(schema.childReportDeliveries.reportId, reportId));
    },
  };
}
