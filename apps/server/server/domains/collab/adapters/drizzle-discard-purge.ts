import type { CommandId, DraftId } from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import { commands } from "@meridian/database/schema";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";

const DISCARD_PURGE_BATCH_LIMIT = 100;
const PURGED_KINDS = ["press", "unpress"] as const;

export function createDrizzleDiscardPurge(
  db: Database,
  deps: {
    workProjection: Pick<WorkProjectionMutation, "mutate">;
    eventSink?: EventSink;
  },
) {
  async function purgeCommand(id: CommandId, draft: DraftId | null): Promise<void> {
    await deps.workProjection.mutate({ drafts: draft ? [draft] : [] }, async () => {
      await currentDrizzleDb(db).delete(commands).where(eq(commands.id, id));
    });
  }

  async function purgeBatch(now: Date): Promise<number> {
    const due = await currentDrizzleDb(db)
      .select({
        id: commands.id,
        draft: sql<DraftId | null>`${commands.outcome} #>> '{result,draft}'`,
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
    for (const { id, draft } of due) {
      try {
        await purgeCommand(id, draft);
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
