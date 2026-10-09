/** The "Updated N links" count: incoming links that name a moved document (contract §10). */
import { isContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isDrafted } from "../../file-policy/index.js";
import type { LiveMembership } from "../ports/live-membership.js";

/**
 * Sums `document_links` occurrences whose target is a moved document or whose ahead ref is settled
 * on one, from live content holders in `projectId`. A drafted holder is live only while the
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
  const holders = await currentDrizzleDb(db).execute<{
    holder: string;
    scheme: string;
    links: number;
  }>(sql`
    SELECT l.source_document_id::text AS holder, s.slug AS scheme,
           sum(l.occurrences)::int AS links
    FROM document_links l
    JOIN documents h ON h.id = l.source_document_id
    JOIN context_sources s ON s.id = h.context_source_id
    LEFT JOIN works w ON w.id = s.work_id
    WHERE (
        l.target_document_id IN (${moved})
        OR l.ahead_id IN (
          SELECT ahead_id FROM link_ahead_refs WHERE settled_document_id IN (${moved})
        )
      )
      AND h.kind = 'content'
      AND h.deleted_at IS NULL
      AND s.deleted_at IS NULL
      AND w.deleted_at IS NULL
      AND coalesce(s.project_id, w.project_id) = ${input.projectId}::uuid
    GROUP BY l.source_document_id, s.slug
  `);
  const live =
    liveMembership && holders.some((row) => manifestGoverned(row.scheme))
      ? await liveMembership.members(input.projectId)
      : null;
  const counted = holders.filter(
    (row) => !live || !manifestGoverned(row.scheme) || live.has(row.holder),
  );
  return {
    links: counted.reduce((sum, row) => sum + row.links, 0),
    documents: counted.length,
  };
}

/** The registry's rule too: a drafted project source is live through the manifest; user:// is not. */
function manifestGoverned(scheme: string): boolean {
  return isContextUriScheme(scheme) && isDrafted(scheme) && scheme !== "user";
}
