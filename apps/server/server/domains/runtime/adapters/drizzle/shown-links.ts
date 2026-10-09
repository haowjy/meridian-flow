/** PostgreSQL `ShownLinkStore` over `thread_shown_links` (contract §7.3). */
import { createHash } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDatabase } from "../../../../shared/drizzle-transaction.js";
import { linkViewKey, type ShownLinkStore, shownLinkLineage } from "../../ports/shown-links.js";

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
      // One row per key and turn; a repeated key in one call would make ON CONFLICT touch a row twice.
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
            showingDigest: showingDigest(link.ref, link.address, input.holderUri, view),
            turnId: input.turnId as TurnId,
          })),
        )
        .onConflictDoUpdate({
          target: [table.threadId, table.documentId, table.showingDigest, table.turnId],
          // `excluded.seq` was drawn before conflict arbitration, so a writer
          // delayed after drawing may arrive second with the smaller value. The
          // exact-tuple guard keeps a (never observed) digest collision from
          // merging two different showings.
          set: { seq: sql`excluded.seq` },
          setWhere: sql`excluded.seq > ${table.seq}
            AND excluded.ref = ${table.ref} AND excluded.address = ${table.address}
            AND excluded.holder_uri = ${table.holderUri} AND excluded.view = ${table.view}`,
        });
    },
    async forDocument(threadId, documentId) {
      const lineage = await shownLinkLineage(threadId as ThreadId, lookup);
      // Each segment selects its eligible rows on its own index prefix; the
      // cutoff applies there, before the latest showing per key is chosen.
      const segments = lineage.map((segment) =>
        segment.maxPosition === null
          ? sql`SELECT l.ref, l.address, l.holder_uri, l.view, l.seq
              FROM ${table} l
              WHERE l.thread_id = ${segment.threadId} AND l.document_id = ${documentId}`
          : sql`SELECT l.ref, l.address, l.holder_uri, l.view, l.seq
              FROM ${table} l JOIN ${schema.turns} t ON t.id = l.turn_id
              WHERE l.thread_id = ${segment.threadId} AND l.document_id = ${documentId}
                AND t.position <= ${segment.maxPosition}`,
      );
      const rows = (await db_().execute(sql`
        SELECT ref, address, holder_uri, view, seq FROM (
          SELECT DISTINCT ON (ref, address, holder_uri, view) ref, address, holder_uri, view, seq
          FROM (${sql.join(segments, sql` UNION ALL `)}) eligible
          ORDER BY ref, address, holder_uri, view, seq DESC
        ) latest
        ORDER BY seq`)) as unknown as Array<{
        ref: string;
        address: string;
        holder_uri: string;
        view: string;
        seq: string | number;
      }>;
      return rows.map((row) => ({
        ref: row.ref,
        address: row.address,
        holderUri: row.holder_uri,
        view: row.view,
        at: Number(row.seq),
      }));
    },
  };
}

/** SHA-256 of the exact showing tuple: the bounded key for unbounded addresses and holders. */
function showingDigest(ref: string, address: string, holderUri: string, view: string): string {
  return createHash("sha256")
    .update(JSON.stringify([ref, address, holderUri, view]))
    .digest("hex");
}
