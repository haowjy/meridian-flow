/** Bounded canonical candidate scope for threads historically associated with a Work. */
import { type SQL, sql } from "drizzle-orm";

export function workAssociationCandidatesSql(input: {
  projectId: string;
  workId: string;
  afterSortAt: string | null;
  afterThreadId: string | null;
  limit: number;
}): SQL {
  return sql`
    SELECT t.id AS thread_id, t.updated_at
    FROM threads t
    JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
    JOIN thread_works matched_tw
      ON matched_tw.thread_id = t.id AND matched_tw.work_id = ${input.workId}::uuid
    WHERE t.project_id = ${input.projectId}::uuid AND t.deleted_at IS NULL
      AND (${input.afterSortAt}::text IS NULL OR
        (t.updated_at, t.id) < (${input.afterSortAt}::timestamptz, ${input.afterThreadId}::uuid))
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ${input.limit}
  `;
}
