/**
 * The registry's address predicate and its draft-settlement writes: the one writer of
 * `link_ahead_draft_settlements` (contract §10.5). The registry settles a ref in a draft
 * at registration; a draft's create settles every waiting ref at its address; closing a
 * draft or discarding its create drops what it meant. Kept apart from the registry's
 * root-transaction machinery so lifecycle code (drafts, hidden nodes) can call it light.
 */
import type { DocumentId, DraftId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { linkAheadDraftSettlements, linkAheadRefs } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentCoordinates } from "../tree/tree-addresses.js";

/** The coordinates a registry row is keyed by. */
export type AddressKey = Pick<
  DocumentCoordinates,
  "projectId" | "scheme" | "workId" | "rootThreadId" | "path"
>;

/** Registry rows at exactly this address. */
export function atAddress(address: AddressKey) {
  return and(
    eq(linkAheadRefs.projectId, address.projectId),
    eq(linkAheadRefs.scheme, address.scheme),
    address.workId === null
      ? isNull(linkAheadRefs.workId)
      : eq(linkAheadRefs.workId, address.workId),
    address.rootThreadId
      ? eq(linkAheadRefs.rootThreadId, address.rootThreadId)
      : isNull(linkAheadRefs.rootThreadId),
    // The index keys the path's md5 (unbounded paths overflow a B-tree tuple); exact recheck.
    sql`md5(${linkAheadRefs.path}) = md5(${address.path})`,
    eq(linkAheadRefs.path, address.path),
  );
}

/**
 * A draft's document arrives at `address` in the draft's view (12a rule 1, §6.2 step 6):
 * every ref there with no live settlement now means it in that draft. One the draft
 * already settled keeps its first meaning. Inside the caller's transaction, which holds
 * the address's namespace and the draft.
 */
export async function settleInDraft(
  db: Database,
  input: { draftId: DraftId; documentId: DocumentId; address: AddressKey },
): Promise<void> {
  await currentDrizzleDb(db).execute(sql`
    INSERT INTO link_ahead_draft_settlements (ahead_id, draft_id, document_id)
    SELECT ${linkAheadRefs.aheadId}, ${input.draftId}::uuid, ${input.documentId}::uuid
    FROM ${linkAheadRefs}
    WHERE ${and(atAddress(input.address), isNull(linkAheadRefs.settledDocumentId))}
    ON CONFLICT DO NOTHING`);
}

/**
 * The draft stops meaning anything by its refs: all of them (closing it), or those naming
 * these documents (a discarded create, whose refs then read "Doesn't exist yet" in the
 * draft). Inside the caller's transaction.
 */
export async function dropDraftSettlements(
  db: Database,
  input: { draftId: DraftId; documentIds?: readonly DocumentId[] },
): Promise<void> {
  if (input.documentIds?.length === 0) return;
  await currentDrizzleDb(db)
    .delete(linkAheadDraftSettlements)
    .where(
      and(
        eq(linkAheadDraftSettlements.draftId, input.draftId),
        input.documentIds
          ? inArray(linkAheadDraftSettlements.documentId, [...input.documentIds])
          : undefined,
      ),
    );
}
