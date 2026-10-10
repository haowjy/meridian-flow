/** A draft branch's journal head: the highest journal id at one generation (§10.8's cut). */
import type { Database } from "@meridian/database";
import { branchWriteJournal } from "@meridian/database/schema";
import { and, eq, max } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DraftBranchJournalHead } from "../domain/draft-branch-ahead-registration.js";

export function createDrizzleDraftBranchJournalHead(db: Database): DraftBranchJournalHead {
  return {
    async lastJournalId(branchId, generation) {
      const [row] = await currentDrizzleDb(db)
        .select({ id: max(branchWriteJournal.id) })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branchId),
            eq(branchWriteJournal.generation, generation),
          ),
        );
      return row?.id ?? null;
    },
  };
}
