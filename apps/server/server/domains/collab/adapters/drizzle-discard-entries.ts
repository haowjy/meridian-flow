/**
 * The document half of Trash's Discard entries (design section 7): every Discard, and every
 * restore that swapped a newer draft out, that ran in the project within the retention, with the
 * text drafts it closed that are still closed. A restore reopens a draft by clearing `closed_by`,
 * so a taken member leaves the entry by itself. A deleted Work's entries are hidden until it is
 * restored, and a purged Work's branches (and so its entries) are gone.
 */
import type { BranchId, DocumentCommandId, ProjectId } from "@meridian/contracts";
import type { DiscardEntry } from "@meridian/contracts/branches";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { branches, documentCommands, documentDrafts, works } from "@meridian/database/schema";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export function createDrizzleDiscardEntries(db: Database) {
  return {
    async list(projectId: ProjectId, now: Date = new Date()): Promise<DiscardEntry[]> {
      const tx = currentDrizzleDb(db);
      const commands = await tx
        .select({
          id: documentCommands.id,
          kind: documentCommands.kind,
          at: documentCommands.createdAt,
          outcome: documentCommands.outcome,
        })
        .from(documentCommands)
        .where(
          and(
            eq(documentCommands.projectId, projectId),
            inArray(documentCommands.kind, ["discard", "undo_discard"]),
            gt(documentCommands.createdAt, deletionPurgeCutoff(now)),
            sql`${documentCommands.outcome}->>'status' = 'done'`,
          ),
        )
        .orderBy(desc(documentCommands.createdAt));
      const ran = commands.flatMap((command) => {
        const result = command.outcome.status === "never" ? null : command.outcome.result;
        return result && "branchId" in result
          ? [{ ...command, branchId: result.branchId as BranchId }]
          : [];
      });
      if (ran.length === 0) return [];
      const owners = new Map(
        (
          await tx
            .select({ id: branches.id, workId: branches.originWorkId })
            .from(branches)
            .leftJoin(works, eq(works.id, branches.originWorkId))
            .where(
              and(
                inArray(branches.id, [...new Set(ran.map((command) => command.branchId))]),
                isNull(works.deletedAt),
              ),
            )
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
                commandId: command.id as DocumentCommandId,
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
