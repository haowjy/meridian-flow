/** Bounded canonical candidate scope for threads historically associated with a Work. */
import { type SQL, sql } from "drizzle-orm";

/**
 * `sortColumn` is the caller's ordering/cursor column on `threads` (for
 * example `t.updated_at` for the Work switcher's recent-summary port, or
 * `t.last_activity_at` for the Work chat feed, which pages by the same
 * stored conversational-activity column as the Project chat feed).
 */
export function workAssociationCandidatesSql(input: {
  projectId: string;
  workId: string;
  sortColumn: SQL;
  afterSortAt: string | null;
  afterThreadId: string | null;
  limit: number;
}): SQL {
  return sql`
    SELECT t.id AS thread_id
    FROM threads t
    JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
    JOIN thread_works matched_tw
      ON matched_tw.thread_id = t.id AND matched_tw.work_id = ${input.workId}::uuid
    WHERE t.project_id = ${input.projectId}::uuid
      AND t.kind = 'primary' AND t.deleted_at IS NULL
      AND (${input.afterSortAt}::text IS NULL OR
        (${input.sortColumn}, t.id) < (${input.afterSortAt}::timestamptz, ${input.afterThreadId}::uuid))
    ORDER BY ${input.sortColumn} DESC, t.id DESC
    LIMIT ${input.limit}
  `;
}
