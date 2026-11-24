import type { DraftId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { drafts, works } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";

type WorkRow = typeof works.$inferInsert & { id: string; draftId?: DraftId | null };

export async function insertWorks(
  db: Database,
  rows: WorkRow | readonly WorkRow[],
  options: { ifAbsent?: boolean } = {},
): Promise<void> {
  const list = Array.isArray(rows) ? rows : [rows as WorkRow];
  await db.transaction(async (tx) => {
    for (const { draftId, ...work } of list) {
      if (draftId)
        await tx
          .insert(drafts)
          .values({
            id: draftId,
            projectId: work.projectId,
            workId: work.id,
            isDefault: true,
            createdBy: work.createdByUserId,
          })
          .onConflictDoNothing();
      const insert = tx.insert(works).values(work);
      await (options.ifAbsent ? insert.onConflictDoNothing() : insert);
    }
  });
}

export async function defaultDraftOf(db: Database, workId: string): Promise<DraftId> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.workId, workId), eq(drafts.isDefault, true)));
  if (!row) throw new Error(`Work ${workId} has no default draft`);
  return row.id as DraftId;
}
