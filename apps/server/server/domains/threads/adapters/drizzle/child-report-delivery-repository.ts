/** Drizzle persistence for durable child-report delivery obligations. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";
import * as schema from "@meridian/database/schema";
import { asc, eq, sql } from "drizzle-orm";
import type {
  ChildReportDeliveryObligation,
  ChildReportDeliveryRepository,
  EnqueueChildReportDeliveryInput,
} from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

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
      return rows.map(
        (row): ChildReportDeliveryObligation => ({
          reportId: row.reportId as TurnId,
          parentThreadId: row.parentThreadId as ThreadId,
          childThreadId: row.childThreadId as ThreadId,
          agentSlug: row.agentSlug,
          description: row.description,
          result: row.result as SpawnResult,
          systemTurnId: row.systemTurnId as TurnId | null,
          submissionEpoch: row.submissionEpoch,
        }),
      );
    },

    async setSystemTurnId(reportId, systemTurnId) {
      await currentDrizzleDb(db)
        .update(schema.childReportDeliveries)
        .set({ systemTurnId })
        .where(eq(schema.childReportDeliveries.reportId, reportId));
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
