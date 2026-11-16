/**
 * The document half of Trash's Discard entries (design section 7): every Discard, and every
 * restore or Un-Apply that swapped a newer draft out, that the day-30 purge hasn't removed, with the
 * text drafts it closed that are still closed. A restore reopens a draft by clearing `closed_by`,
 * so a taken member leaves the entry by itself. A Work in Trash keeps its entries, as an archived
 * Work does (a Restore answers `returned` until the Work is restored); a purged Work's branches
 * (and so its entries) are gone.
 */
import type { BranchId, CommandId, ProjectId } from "@meridian/contracts";
import type { DiscardEntry } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { branches, commands, documentDrafts } from "@meridian/database/schema";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

/** The commands whose id can name closed drafts that Trash lists and Restore reopens. */
export const ENTRY_KINDS = ["discard", "undo_discard", "unapply"] as const;

export function createDrizzleDiscardEntries(db: Database) {
  return {
    async list(projectId: ProjectId): Promise<DiscardEntry[]> {
      const tx = currentDrizzleDb(db);
      const rows = await tx
        .select({
          id: commands.id,
          kind: commands.kind,
          at: commands.createdAt,
          outcome: commands.outcome,
        })
        .from(commands)
        .where(
          and(
            eq(commands.projectId, projectId),
            // An Un-Apply is an entry only through a draft it swapped out, still closed.
            or(
              inArray(commands.kind, ["discard", "undo_discard"]),
              and(
                eq(commands.kind, "unapply"),
                inArray(
                  commands.id,
                  tx
                    .select({ id: documentDrafts.closedBy })
                    .from(documentDrafts)
                    .where(eq(documentDrafts.status, "closed")),
                ),
              ),
            ),
            sql`${commands.outcome}->>'status' = 'done'`,
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
          draftId: documentDrafts.id,
          documentId: documentDrafts.documentId,
          by: documentDrafts.closedBy,
        })
        .from(documentDrafts)
        .where(
          and(
            inArray(
              documentDrafts.closedBy,
              ran.map((command) => command.id),
            ),
            eq(documentDrafts.status, "closed"),
          ),
        );
      return ran.flatMap((command): DiscardEntry[] =>
        owners.has(command.branchId)
          ? [
              {
                commandId: command.id as CommandId,
                kind: command.kind as DiscardEntry["kind"],
                at: command.at.toISOString(),
                branchId: command.branchId,
                workId: owners.get(command.branchId) ?? null,
                drafts: drafts
                  .filter((draft) => draft.by === command.id)
                  .map(({ draftId, documentId }) => ({ draftId, documentId })),
              },
            ]
          : [],
      );
    },
  };
}
