/** Server-only current and derivation-source Scratch locations, read when expanding shorthand. */
import type { ContextNotesLocation, ContextNotesScope } from "@meridian/contracts/context-uri";
import { threads } from "@meridian/database/schema";
import { type SQL, sql } from "drizzle-orm";

function notesLocation(threadId: SQL): SQL<ContextNotesLocation | null> {
  return sql`(SELECT CASE WHEN note.ref IS NOT NULL AND (NOT w.is_no_work OR root.ref IS NOT NULL)
    THEN jsonb_build_object('threadRef', note.ref, 'owner', CASE WHEN w.is_no_work
      THEN jsonb_build_object('kind', 'lineage', 'rootThreadRef', root.ref)
      ELSE jsonb_build_object('kind', 'work', 'workSlug', w.slug) END) END
    FROM threads note JOIN thread_works membership ON membership.thread_id = note.id AND membership.is_primary
    JOIN works w ON w.id = membership.work_id LEFT JOIN threads root ON root.id = note.root_thread_id
    WHERE note.id = ${threadId})`;
}

export const threadNotesScope = sql<ContextNotesScope>`jsonb_strip_nulls(jsonb_build_object(
  'current', ${notesLocation(sql`${threads}.id`)},
  'parent', ${notesLocation(sql`CASE WHEN ${threads}.origin_type IN ('fork', 'handoff')
    THEN ${threads}.derivation_source_thread_id
    ELSE ${threads}.parent_thread_id END`)}))`;
