/** PostgreSQL `ShownLinkStore` over `thread_shown_links` (contract §7.3). */
import type { DocumentId } from "@meridian/contracts";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDatabase } from "../../../../shared/drizzle-transaction.js";
import {
  latestShowings,
  linkViewKey,
  type ShownLinkStore,
  shownLinkLineage,
} from "../../ports/shown-links.js";

export function createDrizzleShownLinkStore(db: DrizzleDatabase): ShownLinkStore {
  const db_ = () => currentDrizzleDb(db);
  const table = schema.threadShownLinks;
  const lookup = {
    async thread(threadId: ThreadId) {
      const [row] = await db_()
        .select({
          originType: schema.threads.originType,
          originTurnId: schema.threads.originTurnId,
        })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId));
      return row ?? null;
    },
    async turn(turnId: string) {
      const [row] = await db_()
        .select({ threadId: schema.turns.threadId, position: schema.turns.position })
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId as TurnId));
      return row ?? null;
    },
  };
  return {
    async record(input) {
      if (input.links.length === 0) return;
      const view = linkViewKey(input.view);
      // One row per key; a repeated key in one call would make ON CONFLICT touch a row twice.
      const unique = new Map(input.links.map((link) => [`${link.ref}\0${link.address}`, link]));
      await db_()
        .insert(table)
        .values(
          [...unique.values()].map((link) => ({
            threadId: input.threadId as ThreadId,
            documentId: input.documentId as DocumentId,
            ref: link.ref,
            address: link.address,
            holderUri: input.holderUri,
            view,
            turnId: input.turnId as TurnId,
          })),
        )
        .onConflictDoUpdate({
          target: [
            table.threadId,
            table.documentId,
            table.ref,
            table.address,
            table.holderUri,
            table.view,
          ],
          // `excluded.seq` is the fresh sequence value drawn for the proposed row.
          set: { seq: sql`excluded.seq`, turnId: sql`excluded.turn_id` },
        });
    },
    async forDocument(threadId, documentId) {
      const lineage = await shownLinkLineage(threadId as ThreadId, lookup);
      const rows = await db_()
        .select({
          ref: table.ref,
          address: table.address,
          holderUri: table.holderUri,
          view: table.view,
          at: table.seq,
        })
        .from(table)
        .leftJoin(schema.turns, eq(schema.turns.id, table.turnId))
        .where(
          and(
            eq(table.documentId, documentId as DocumentId),
            or(
              ...lineage.map((segment) =>
                segment.maxPosition === null
                  ? eq(table.threadId, segment.threadId)
                  : and(
                      eq(table.threadId, segment.threadId),
                      lte(schema.turns.position, segment.maxPosition),
                    ),
              ),
            ),
          ),
        );
      return latestShowings(rows);
    },
  };
}
