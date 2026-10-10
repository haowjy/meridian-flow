/**
 * The one writer of `link_ahead_holder_bindings` (contract §10.5): what an ahead ref in a
 * published holder means there, written by Apply's after-admission step from the
 * payload's staged meanings, never re-read from a draft's settlements (V2-H4). A later
 * Apply's binding wins for that holder (12b-Q3). Discard never deletes one: a binding to a
 * tombstone reads gone. Inside the caller's transaction.
 */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { linkAheadHolderBindings } from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export async function bindHolderRefs(
  db: Database,
  holders: readonly {
    holderDocumentId: DocumentId;
    refs: readonly { aheadId: string; documentId: DocumentId }[];
  }[],
): Promise<void> {
  // One row per (ref, holder): an upsert can't touch a row twice in one statement.
  const rows = [
    ...new Map(
      holders.flatMap(({ holderDocumentId, refs }) =>
        refs.map((ref) => [
          `${ref.aheadId}:${holderDocumentId}`,
          { aheadId: ref.aheadId, holderDocumentId, documentId: ref.documentId },
        ]),
      ),
    ).values(),
  ];
  if (rows.length === 0) return;
  await currentDrizzleDb(db)
    .insert(linkAheadHolderBindings)
    .values(rows)
    .onConflictDoUpdate({
      target: [linkAheadHolderBindings.aheadId, linkAheadHolderBindings.holderDocumentId],
      set: { documentId: sql`excluded.document_id`, boundAt: sql`now()` },
    });
}
