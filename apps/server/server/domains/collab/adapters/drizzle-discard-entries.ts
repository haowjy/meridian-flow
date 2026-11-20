/**
 * The text half of Trash's Discard entries: every press Discard the day-30 purge hasn't removed,
 * with the documents whose suggestions it rejected and its Undo hasn't taken back. Restore is the
 * press's Undo. A Discard of one change in the text has no entry: its Undo is Ctrl+Z. A Work in
 * Trash keeps its entries, as an archived Work does.
 */
import type { CommandId, ProjectId } from "@meridian/contracts";
import { draftOwnerFromKey } from "@meridian/contracts";
import type { DiscardEntry, PressResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { commands, pressTextEffects } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export function createDrizzleDiscardEntries(db: Database) {
  return {
    async list(projectId: ProjectId): Promise<DiscardEntry[]> {
      const tx = currentDrizzleDb(db);
      const rows = await tx
        .select({ id: commands.id, at: commands.createdAt, outcome: commands.outcome })
        .from(commands)
        .where(
          and(
            eq(commands.projectId, projectId),
            eq(commands.kind, "press"),
            sql`${commands.outcome}->>'status' = 'done'`,
            sql`${commands.outcome} #>> '{result,verdict}' = 'discard'`,
          ),
        )
        .orderBy(desc(commands.createdAt));
      const pressed = rows.flatMap((row) =>
        row.outcome.status === "done"
          ? [{ ...row, result: row.outcome.result as PressResult }]
          : [],
      );
      if (pressed.length === 0) return [];
      const open = await tx
        .select({ commandId: pressTextEffects.commandId, documentId: pressTextEffects.documentId })
        .from(pressTextEffects)
        .where(
          and(
            inArray(
              pressTextEffects.commandId,
              pressed.map((row) => row.id),
            ),
            isNull(pressTextEffects.undoneBy),
          ),
        );
      return pressed.map((row): DiscardEntry => {
        const owner = draftOwnerFromKey(row.result.owner, projectId);
        return {
          commandId: row.id as CommandId,
          at: row.at.toISOString(),
          owner: row.result.owner,
          workId: owner?.kind === "work" ? owner.workId : null,
          documents: open.filter((one) => one.commandId === row.id).map((one) => one.documentId),
        };
      });
    },
  };
}
