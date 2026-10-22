/** The edit history's one chronology, shared by collab's tree entries and the tree's settlements. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";

/**
 * A tree entry's place in the history: the next value of the parts' id sequence, so one
 * chronology orders tree entries and text parts across turns and writers.
 */
export async function nextEditSeq(db: Pick<Database, "execute">): Promise<number> {
  const rows = await db.execute(
    sql`select nextval(pg_get_serial_sequence('document_edit_parts', 'id'))::text as seq`,
  );
  const seq = Array.from(rows as unknown as Iterable<{ seq: string }>)[0]?.seq;
  if (seq === undefined) throw new Error("The edit history sequence returned nothing");
  return Number(seq);
}
