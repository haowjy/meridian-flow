/**
 * The document half of Trash's Discard entries (design section 5): every Discard of whole drafts
 * the day-30 purge hasn't removed, with the drafts it took text from that no Restore has ended. A
 * Discard of single changes has no entry: its Undo is the notice's or Ctrl+Z, and it is final
 * otherwise. A Restore ends an
 * entry by setting `ended_by` on the command's effects. A Work in Trash keeps its entries, as an
 * archived Work does (a Restore answers `returned` until the Work is restored); a purged Work's
 * branches (and so its entries) are gone.
 */
import type { BranchId, CommandId, ProjectId } from "@meridian/contracts";
import type { DiscardEntry } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { branches, commands, discardCommandEffects } from "@meridian/database/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export function createDrizzleDiscardEntries(db: Database) {
  return {
    async list(projectId: ProjectId): Promise<DiscardEntry[]> {
      const tx = currentDrizzleDb(db);
      const rows = await tx
        .select({
          id: commands.id,
          at: commands.createdAt,
          outcome: commands.outcome,
        })
        .from(commands)
        .where(
          and(
            eq(commands.projectId, projectId),
            eq(commands.kind, "discard"),
            sql`${commands.outcome}->>'status' = 'done'`,
            sql`${commands.outcome} #>> '{result,whole}' = 'true'`,
          ),
        )
        .orderBy(desc(commands.createdAt));
      const ran = rows.flatMap((command) => {
        const result = command.outcome.status === "never" ? null : command.outcome.result;
        return result && typeof result === "object" && "branchId" in result
          ? [{ ...command, branchId: result.branchId as BranchId }]
          : [];
      });
      if (ran.length === 0) return [];
      const owners = new Map(
        (
          await tx
            .select({ id: branches.id, workId: branches.originWorkId })
            .from(branches)
            .where(inArray(branches.id, [...new Set(ran.map((command) => command.branchId))]))
        ).map((row) => [row.id, row.workId]),
      );
      const drafts = await tx
        .select({
          commandId: discardCommandEffects.commandId,
          draftId: discardCommandEffects.draftId,
          documentId: discardCommandEffects.documentId,
        })
        .from(discardCommandEffects)
        .where(
          and(
            inArray(
              discardCommandEffects.commandId,
              ran.map((command) => command.id),
            ),
            isNull(discardCommandEffects.endedBy),
          ),
        );
      return ran.flatMap((command): DiscardEntry[] =>
        owners.has(command.branchId)
          ? [
              {
                commandId: command.id as CommandId,
                at: command.at.toISOString(),
                branchId: command.branchId,
                workId: owners.get(command.branchId) ?? null,
                drafts: drafts
                  .filter((draft) => draft.commandId === command.id)
                  .map(({ draftId, documentId }) => ({ draftId, documentId })),
              },
            ]
          : [],
      );
    },
  };
}
