import { createHash } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { loroRoomName } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  runIsolatedFromAmbientTransaction,
} from "../../../shared/drizzle-transaction.js";
import {
  type FrontierRooms,
  linkViewKey,
  shownLinkLineage,
} from "../../../shared/model-evidence.js";
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

  const ofDocuments = (documentIds: readonly string[]) => {
    const ids = documentIds.join(",");
    const lives = documentIds.map((documentId) => loroRoomName({ kind: "live", documentId }));
    return sql`(${frontiers.roomKey} = ANY(string_to_array(${lives.join(",")}, ','))
      OR (${frontiers.roomKey} LIKE 'fork:%'
        AND split_part(${frontiers.roomKey}, ':', 3) = ANY(string_to_array(${ids}, ','))))`;
  };
  const inRooms = (rooms: FrontierRooms) =>
    "room" in rooms ? eq(frontiers.roomKey, rooms.room) : ofDocuments([rooms.documentId]);

  return {
    async resultStored(evidence) {
      const owner = {
        projectId: evidence.projectId,
        threadId: evidence.threadId as ThreadId,
      };
      if (evidence.frontiers.length > 0) {
        const blockIds = evidence.frontiers.map(({ blockId }) => blockId as never);
        await db_().delete(frontiers).where(inArray(frontiers.sourceBlockId, blockIds));
        await db_()
          .insert(frontiers)
          .values(
            evidence.frontiers.map(({ blockId, frontier }) => ({
              ...owner,
              sourceBlockId: blockId as never,
              roomKey: frontier.room,
              snapshot: Buffer.from(frontier.snapshot),
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
            set: { seq: sql`excluded.seq` },
            setWhere: sql`excluded.seq > ${links.seq}
              AND excluded.ref = ${links.ref} AND excluded.address = ${links.address}
              AND excluded.holder_uri = ${links.holderUri} AND excluded.view = ${links.view}`,
          });
      }
    },

    async latestFrontier(documentId, blockIds) {
      if (blockIds.length === 0) return null;
      // Inside a transaction a savepoint, so a failed lookup leaves the caller's usable.
      const [row] = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({ room: frontiers.roomKey, snapshot: frontiers.snapshot })
          .from(frontiers)
          .where(and(inRooms({ documentId }), amongBlocks(blockIds)))
          .orderBy(sql`${frontiers.recordedSeq} DESC NULLS LAST`)
          .limit(1),
      );
      return row ? { room: row.room, snapshot: new Uint8Array(row.snapshot) } : null;
    },

    async frontiersIn(rooms, blockIds) {
      if (blockIds.length === 0) return [];
      const rows = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({
            blockId: frontiers.sourceBlockId,
            recordedSeq: frontiers.recordedSeq,
            snapshot: frontiers.snapshot,
          })
          .from(frontiers)
          .where(and(inRooms(rooms), amongBlocks(blockIds)))
          .orderBy(frontiers.recordedSeq),
      );
      return rows.map((row) => ({
        blockId: row.blockId,
        recordedSeq: Number(row.recordedSeq),
        snapshot: new Uint8Array(row.snapshot),
      }));
    },

    async forDocument(threadId, documentId) {
      const segments = (await shownLinkLineage(threadId as ThreadId, lineage)).map((segment) =>
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

    async forgetFrontiers(rooms) {
      if ("room" in rooms) {
        await db_().delete(frontiers).where(inRooms(rooms));
        return;
      }
      if (rooms.documentIds.length === 0) return;
      const accountProjects = db_()
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.userId, rooms.accountId));
      await db_()
        .delete(frontiers)
        .where(and(inArray(frontiers.projectId, accountProjects), ofDocuments(rooms.documentIds)));
    },
  };
}

function showingDigest(ref: string, address: string, holderUri: string, view: string): string {
  return createHash("sha256")
    .update(JSON.stringify([ref, address, holderUri, view]))
    .digest("hex");
}
