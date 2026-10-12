/** The "Updated N links" count: incoming links that name a moved document (contract §10). */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { listsThroughLiveManifest, loadDocumentAddresses } from "../adapters/document-address.js";
import type { LiveMembership } from "../ports/live-membership.js";

/**
 * Sums `document_links` occurrences whose target is a moved document or whose ahead ref is settled
 * on one, from live content holders in `projectId` (present where they live now, including under
 * their folders: the address module's deleted-ancestor rule). A drafted holder is live only while the
 * project's live manifest holds it; a draft-only or discarded row is not. A moved holder's own
 * links to unmoved documents are not counted; one moved document naming another is. Personal and
 * other-project holders are not counted. Runs inside the move transaction, after settlement, so a
 * ref the move itself settled counts.
 */
export async function countIncomingLinks(
  db: Database,
  input: { projectId: ProjectId; movedDocumentIds: readonly DocumentId[] },
  liveMembership?: Pick<LiveMembership, "members">,
): Promise<{ links: number; documents: number }> {
  if (input.movedDocumentIds.length === 0) return { links: 0, documents: 0 };
  const moved = sql.join(
    [...new Set(input.movedDocumentIds)].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const sums = await currentDrizzleDb(db).execute<{ holder: string; links: number }>(sql`
    SELECT l.source_document_id::text AS holder, sum(l.occurrences)::int AS links
    FROM document_links l
    WHERE l.target_document_id IN (${moved})
      OR l.ahead_id IN (
        SELECT ahead_id FROM link_ahead_refs WHERE settled_document_id IN (${moved})
      )
    GROUP BY l.source_document_id
  `);
  const links = new Map(sums.map((row) => [row.holder, row.links]));
  const holders = (await loadDocumentAddresses(db, { ids: [...links.keys()] })).filter(
    (holder) => !holder.deleted && holder.projectId === input.projectId,
  );
  const live =
    liveMembership && holders.some((holder) => listsThroughLiveManifest(holder.scheme))
      ? await liveMembership.members(input.projectId)
      : null;
  const counted = holders.filter(
    (holder) => !live || !listsThroughLiveManifest(holder.scheme) || live.has(holder.documentId),
  );
  return {
    links: counted.reduce((sum, holder) => sum + (links.get(holder.documentId) ?? 0), 0),
    documents: counted.length,
  };
}
