/**
 * Day-30 purge of Trash's Discard entries: the command row, which carries its effects (the only
 * copy of the discarded text) with it, in one transaction. This is the only reader of the clock for
 * them: Trash lists and Restore merges whatever still exists, so what is listed is exactly what
 * restores, and a Restore after the purge finds no command and answers `left_out purged`. A
 * drafted create's draft is not ours: the tree purges the create on its own clock
 * (`purgeUnviewed`), and the tree's `discarded` settlements stay.
 *
 * Lock order, a prefix of Restore's: the Work (no `requireActive`: an archived or deleted Work's
 * entries expire too). A Restore and the purge take the same Work lock, so a Restore sees all of an
 * entry or none of it. A row whose branch is gone (its Work was purged, which cascades the branch
 * but not `commands`) has nothing to lock.
 */
import type { CommandId } from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { commands } from "@meridian/database/schema";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";

const DISCARD_PURGE_BATCH_LIMIT = 100;
/** A Restore's and an Un-Apply's rows go on the Discard's clock: they only ever name its entry. */
const PURGED_KINDS = ["discard", "undo_discard", "unapply"] as const;

export function createDrizzleDiscardPurge(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    eventSink?: EventSink;
  },
) {
  async function purgeCommand(id: CommandId, branchId: string | null): Promise<void> {
    await deps.workProjection.mutate(
      branchId ? { branches: [branchId as never] } : {},
      async () => {
        await currentDrizzleDb(db).delete(commands).where(eq(commands.id, id));
      },
    );
  }

  /**
   * One batch of the oldest due entries, each its own transaction: a failure is logged with its id
   * and stays for the next pass, and does not stop the entries after it. Returns how many it took.
   */
  async function purgeBatch(now: Date): Promise<number> {
    const due = await currentDrizzleDb(db)
      .select({
        id: commands.id,
        branchId: sql<string | null>`${commands.outcome} #>> '{result,branchId}'`,
      })
      .from(commands)
      .where(
        and(
          inArray(commands.kind, [...PURGED_KINDS]),
          lte(commands.createdAt, deletionPurgeCutoff(now)),
        ),
      )
      .orderBy(commands.createdAt)
      .limit(DISCARD_PURGE_BATCH_LIMIT);
    let taken = 0;
    for (const { id, branchId } of due) {
      try {
        await purgeCommand(id, branchId);
        taken += 1;
      } catch (error) {
        if (!deps.eventSink) throw error;
        emitEvent(deps.eventSink, {
          level: "error",
          source: "collab.discard-purge",
          name: "purge.failed",
          payload: { id, error },
        });
      }
    }
    return taken;
  }

  return {
    /** Purges every entry older than the retention, batch by batch; the command rows it removed. */
    async purge(now: Date = new Date()): Promise<number> {
      let purged = 0;
      for (;;) {
        const taken = await purgeBatch(now);
        purged += taken;
        if (taken < DISCARD_PURGE_BATCH_LIMIT) return purged;
      }
    },
  };
}
