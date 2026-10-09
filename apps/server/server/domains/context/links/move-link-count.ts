/** The "Updated N links" count: incoming links that name a moved document (contract §10). */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

/**
 * Sums `document_links` occurrences whose target is a moved document or whose ahead ref is settled
 * on one, from live content holders in `projectId`. A moved holder's own links to unmoved
 * documents are not counted; one moved document naming another is. Personal and other-project
 * holders are not counted. Runs inside the move transaction, after settlement, so a ref the move
 * itself settled counts.
 */
export async function countIncomingLinks(
  db: Database,
  input: { projectId: ProjectId; movedDocumentIds: readonly DocumentId[] },
): Promise<{ links: number; documents: number }> {
  if (input.movedDocumentIds.length === 0) return { links: 0, documents: 0 };
  const moved = sql.join(
    [...new Set(input.movedDocumentIds)].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [row] = await currentDrizzleDb(db).execute<{ links: number; documents: number }>(sql`
    SELECT coalesce(sum(l.occurrences), 0)::int AS links,
           count(DISTINCT l.source_document_id)::int AS documents
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
  `);
  return { links: row?.links ?? 0, documents: row?.documents ?? 0 };
}
