/** Reads of the stored block rows, and the freshness rules that decide who may trust them. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBlockRooms, documentBlocks, documents, treeNodes } from "@meridian/database";
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

/**
 * The documents of a project and an account that can hold any of `drafts`' suggestions, read in
 * the caller's transaction: every row whose cut is current and lists one of them in
 * `pending_changes`, and every row a reader may not trust (`staleForReaders`), which the caller
 * reads from the room. Exact for every committed write, since each live write moves its
 * document's head (`allocateAdmission`): what the derivation hasn't caught up on is stale.
 */
export async function documentsHolding(
  db: Database,
  scope: { projectId: ProjectId | null; userId: UserId },
  drafts: readonly DraftId[],
): Promise<{ id: DocumentId; projectId: ProjectId | null; userId: UserId | null }[]> {
  if (drafts.length === 0) return [];
  return currentDrizzleDb(db)
    .select({ id: documents.id, projectId: documents.projectId, userId: documents.userId })
    .from(documents)
    .leftJoin(documentBlockRooms, eq(documentBlockRooms.documentId, documents.id))
    .leftJoin(treeNodes, eq(treeNodes.id, documents.id))
    .where(
      and(
        or(
          scope.projectId ? eq(documents.projectId, scope.projectId) : undefined,
          eq(documents.userId, scope.userId),
        ),
        or(
          staleForReaders,
          sql`${documentBlockRooms.pendingChanges} ?| array[${sql.join(
            drafts.map((draft) => sql`${draft}`),
            sql`, `,
          )}]::text[]`,
        ),
      ),
    );
}

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
            // A Work's reader sees its own suggestions, which the stored blocks leave out.
            draft ? sql`not (${documentBlockRooms.pendingChanges} ? ${draft})` : undefined,
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
