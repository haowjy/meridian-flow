import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  documentBlockRooms,
  documentBlocks,
  documentForks,
  documents,
  treeNodes,
} from "@meridian/database";
import { and, eq, inArray, isNull, lte, ne, not, or, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { BlockText } from "../domain/ports/block-text.js";
import { DOCUMENT_EXTRACTOR_VERSION } from "../domain/ports/document-derivations.js";

/**
 * The version text derivations compare: the live row's, and 0 for a document no live row places.
 * Needs `treeNodes` left-joined on the document.
 */
export const liveLocationVersion = sql<bigint>`coalesce(${treeNodes.locationVersion}, 0)`.mapWith(
  BigInt,
);

/**
 * Both predicates need `documentBlockRooms` left-joined to `documents` and `treeNodes`.
 * `cutBehind`: the derivation's cut differs from the document's saved content or location.
 */
const cutBehind = [
  ne(documentBlockRooms.cutContentSeq, documents.contentSeq),
  sql`${documentBlockRooms.cutLocationVersion} <> coalesce(${treeNodes.locationVersion}, 0)`,
];
const otherExtractor = ne(documentBlockRooms.extractorVersion, DOCUMENT_EXTRACTOR_VERSION);

/**
 * What a reader may not trust: no room, behind the document, or written by any other extractor
 * version. A newer build's room is no older build's truth, so an older build's readers fall
 * back to the room copy for it.
 */
export const staleForReaders = or(
  isNull(documentBlockRooms.roomId),
  ...cutBehind,
  otherExtractor,
) as SQL;

/**
 * What the sweep should derive: no room, or behind and written by this build or an older one.
 * Builds overlap briefly in a deploy; a room a newer extractor certified is that build's to keep
 * current, and certify refuses this build's writes to it, so retrying it only burns attempts.
 */
export const staleForSweep = or(
  isNull(documentBlockRooms.roomId),
  and(
    lte(documentBlockRooms.extractorVersion, DOCUMENT_EXTRACTOR_VERSION),
    or(...cutBehind, otherExtractor),
  ),
) as SQL;

export function createDrizzleBlockText(db: Database): BlockText {
  const current = (ids: DocumentId[]) =>
    and(inArray(documentBlockRooms.documentId, ids), not(staleForReaders));
  return {
    async grepTexts(ids, { draft }) {
      if (!ids.length) return new Map();
      // The watermark and the text come from one snapshot: one statement.
      const rows = await currentDrizzleDb(db)
        .select({
          id: documentBlockRooms.documentId,
          text: sql<string>`coalesce((
            select string_agg(${documentBlocks.text}, E'\n' order by o.position)
            from unnest(${documentBlockRooms.blockOrder}) with ordinality as o(block_id, position)
            join ${documentBlocks} on ${documentBlocks.roomId} = ${documentBlockRooms.roomId}
              and ${documentBlocks.blockId} = o.block_id
          ), '')`,
        })
        .from(documentBlockRooms)
        .innerJoin(documents, eq(documents.id, documentBlockRooms.documentId))
        .leftJoin(treeNodes, eq(treeNodes.id, documents.id))
        .where(
          and(
            current(ids),
            // The stored blocks are Live's: a reader whose draft has a fork of the document reads
            // the fork instead.
            draft
              ? sql`not exists (select 1 from ${documentForks} where ${documentForks.documentId} = ${documents.id}
                  and ${documentForks.draftId} = ${draft})`
              : undefined,
          ),
        );
      return new Map(rows.map((row) => [row.id, row.text]));
    },
    async wordCounts(ids) {
      if (!ids.length) return new Map();
      const rows = await currentDrizzleDb(db)
        .select({ id: documentBlockRooms.documentId, words: documentBlockRooms.wordCount })
        .from(documentBlockRooms)
        .innerJoin(documents, eq(documents.id, documentBlockRooms.documentId))
        .leftJoin(treeNodes, eq(treeNodes.id, documents.id))
        .where(current(ids));
      return new Map(rows.map((row) => [row.id, row.words]));
    },
  };
}
