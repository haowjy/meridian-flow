/** Postgres `ModelEvidence` over `observation_frontiers` and `thread_shown_links`. */
import { createHash } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  runIsolatedFromAmbientTransaction,
} from "../../../shared/drizzle-transaction.js";
import { linkViewKey, shownLinkLineage } from "../../../shared/model-evidence.js";
import type { ModelEvidence } from "../domain/model-evidence.js";

export function createDrizzleModelEvidence(db: DrizzleDatabase): ModelEvidence {
  const db_ = () => currentDrizzleDb(db);
  const frontiers = schema.observationFrontiers;
  const links = schema.threadShownLinks;
  const lineage = {
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
  // One text parameter, not one per block: a long conversation has thousands. Compared as text,
  // so a block id that is not a UUID matches nothing instead of failing the cast.
  const amongBlocks = (blockIds: readonly string[]) =>
    sql`${frontiers.sourceBlockId}::text = ANY(string_to_array(${blockIds.join(",")}, ','))`;

  return {
    async resultStored(evidence) {
      const owner = {
        projectId: evidence.projectId,
        threadId: evidence.threadId as ThreadId,
      };
      if (evidence.frontiers.length > 0) {
        const blockIds = evidence.frontiers.map(({ blockId }) => blockId as never);
        // A block shown again holds its new frontier only: the old row goes first.
        await db_().delete(frontiers).where(inArray(frontiers.sourceBlockId, blockIds));
        await db_()
          .insert(frontiers)
          .values(
            evidence.frontiers.map(({ blockId, frontier }) => ({
              ...owner,
              sourceBlockId: blockId as never,
              roomKey: frontier.room,
              snapshot: Buffer.from(frontier.snapshot),
              journalPosition: frontier.position,
            })),
          );
      }
      for (const showing of evidence.shown) {
        if (showing.links.length === 0) continue;
        const view = linkViewKey(showing.view);
        // One row per key and turn; a repeated key in one call would make ON CONFLICT touch a row twice.
        const unique = new Map(showing.links.map((link) => [`${link.ref}\0${link.address}`, link]));
        await db_()
          .insert(links)
          .values(
            [...unique.values()].map((link) => ({
              projectId: evidence.projectId,
              threadId: evidence.threadId as ThreadId,
              documentId: showing.documentId as DocumentId,
              ref: link.ref,
              address: link.address,
              holderUri: showing.holderUri,
              view,
              showingDigest: showingDigest(link.ref, link.address, showing.holderUri, view),
              turnId: evidence.turnId as TurnId,
            })),
          )
          .onConflictDoUpdate({
            target: [links.threadId, links.documentId, links.showingDigest, links.turnId],
            // `excluded.seq` was drawn before conflict arbitration, so a writer
            // delayed after drawing may arrive second with the smaller value. The
            // exact-tuple guard keeps a (never observed) digest collision from
            // merging two different showings.
            set: { seq: sql`excluded.seq` },
            setWhere: sql`excluded.seq > ${links.seq}
              AND excluded.ref = ${links.ref} AND excluded.address = ${links.address}
              AND excluded.holder_uri = ${links.holderUri} AND excluded.view = ${links.view}`,
          });
      }
    },

    async latestFrontier(room, blockIds) {
      if (blockIds.length === 0) return null;
      // Ordered as the index is (`room_key, recorded_seq DESC NULLS LAST`) so the scan walks the
      // room newest first and stops at the first row among these blocks. Inside a transaction a
      // savepoint, so a failed lookup leaves the caller's usable.
      const [row] = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({ snapshot: frontiers.snapshot, journalPosition: frontiers.journalPosition })
          .from(frontiers)
          .where(and(eq(frontiers.roomKey, room), amongBlocks(blockIds)))
          .orderBy(sql`${frontiers.recordedSeq} DESC NULLS LAST`)
          .limit(1),
      );
      return row
        ? {
            room,
            snapshot: new Uint8Array(row.snapshot),
            ...(row.journalPosition === null ? {} : { position: row.journalPosition }),
          }
        : null;
    },

    async frontiersIn(room, blockIds) {
      if (blockIds.length === 0) return [];
      const rows = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({
            blockId: frontiers.sourceBlockId,
            recordedSeq: frontiers.recordedSeq,
            snapshot: frontiers.snapshot,
          })
          .from(frontiers)
          .where(and(eq(frontiers.roomKey, room), amongBlocks(blockIds)))
          .orderBy(frontiers.recordedSeq),
      );
      return rows.map((row) => ({
        blockId: row.blockId,
        recordedSeq: Number(row.recordedSeq),
        snapshot: new Uint8Array(row.snapshot),
      }));
    },

    async latestRoom(rooms, blockIds) {
      if (rooms.length === 0 || blockIds.length === 0) return null;
      const [row] = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({ room: frontiers.roomKey })
          .from(frontiers)
          .where(and(inArray(frontiers.roomKey, [...rooms]), amongBlocks(blockIds)))
          .orderBy(sql`${frontiers.recordedSeq} DESC NULLS LAST`)
          .limit(1),
      );
      return row?.room ?? null;
    },

    async forDocument(threadId, documentId) {
      const segments = (await shownLinkLineage(threadId as ThreadId, lineage)).map((segment) =>
        // Each segment selects its eligible rows on its own index prefix; the cutoff applies
        // there, before the latest showing per key is chosen.
        segment.maxPosition === null
          ? sql`SELECT l.ref, l.address, l.holder_uri, l.view, l.seq
              FROM ${links} l
              WHERE l.thread_id = ${segment.threadId} AND l.document_id = ${documentId}`
          : sql`SELECT l.ref, l.address, l.holder_uri, l.view, l.seq
              FROM ${links} l JOIN ${schema.turns} t ON t.id = l.turn_id
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

    async forgetThreads(threadIds) {
      if (threadIds.length === 0) return;
      await db_()
        .delete(frontiers)
        .where(inArray(frontiers.threadId, [...threadIds]));
      await db_()
        .delete(links)
        .where(inArray(links.threadId, [...threadIds]));
      await db_()
        .delete(schema.commands)
        .where(inArray(schema.commands.threadId, [...threadIds]));
    },
  };
}

/** SHA-256 of the exact showing tuple: the bounded key for unbounded addresses and holders. */
function showingDigest(ref: string, address: string, holderUri: string, view: string): string {
  return createHash("sha256")
    .update(JSON.stringify([ref, address, holderUri, view]))
    .digest("hex");
}
