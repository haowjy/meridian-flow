/**
 * Day-30 purge of presses and their Undos: the command row, which carries its text effects with
 * it, in one transaction. This is the only reader of the clock for them: Trash lists and Undo
 * takes back whatever still exists, so what is listed is exactly what restores, and an Undo after
 * the purge finds no press and takes nothing back. A drafted create is not ours: the tree purges
 * it on its own clock (`purgeUnviewed`), and the tree's `discarded` settlements stay.
 *
 * Lock order, a prefix of Undo's: the Work (no `requireActive`: an archived or deleted Work's
 * entries expire too), so an Undo sees all of a press or none of it.
 */
import {
  type CommandId,
  parseDraftOwnerKey,
  type ThreadId,
  type WorkId,
} from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { commands } from "@meridian/database/schema";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";

const DISCARD_PURGE_BATCH_LIMIT = 100;
/** A press can be undone for as long as its row lives; an Undo's row only ever names its press. */
const PURGED_KINDS = ["press", "unpress"] as const;

export function createDrizzleDiscardPurge(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    eventSink?: EventSink;
  },
) {
  async function purgeCommand(id: CommandId, ownerKey: string | null): Promise<void> {
    const owner = ownerKey ? parseDraftOwnerKey(ownerKey) : null;
    await deps.workProjection.mutate(
      owner?.kind === "work"
        ? { works: [owner.id as WorkId] }
        : owner
          ? { lineages: [owner.id as ThreadId] }
          : {},
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
        owner: sql<string | null>`${commands.outcome} #>> '{result,owner}'`,
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
    for (const { id, owner } of due) {
      try {
        await purgeCommand(id, owner);
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
