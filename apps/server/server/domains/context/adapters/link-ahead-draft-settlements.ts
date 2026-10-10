/**
 * What an ahead ref means in a draft: the one writer of `link_ahead_draft_settlements`
 * and its policy (contract §10.5), with the registry's address predicate. A ref takes a
 * draft's meaning only while it has no live settlement, and keeps the first meaning the
 * draft gave it. Three writes: a draft's create settles every ref waiting at its address,
 * a registration in a draft settles each ref on the draft's single occupant, and closing
 * a draft or ending its use of a create drops what it meant. The registry keeps its root
 * transaction and locks and calls in here; lifecycle code (drafts, hidden nodes) calls
 * in here without the registry's machinery. Every write runs in the caller's
 * transaction, which holds the draft and the addresses' namespaces.
 */
import type { DocumentId, DraftId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { linkAheadDraftSettlements, linkAheadRefs } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentCoordinates } from "../tree/tree-addresses.js";
import { coordinatesKey, createTreeReader } from "../tree/tree-view.js";

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

/** Only a ref with no live settlement takes a draft's meaning (12a rule 1). */
const waitingLive = () => isNull(linkAheadRefs.settledDocumentId);

/**
 * A draft's document arrives at `address` in the draft's view (§6.2 step 6): every ref
 * waiting there now means it in that draft. One the draft already settled keeps its
 * first meaning.
 */
export async function settleInDraft(
  db: Database,
  input: { draftId: DraftId; documentId: DocumentId; address: AddressKey },
): Promise<void> {
  await currentDrizzleDb(db).execute(sql`
    INSERT INTO link_ahead_draft_settlements (ahead_id, draft_id, document_id)
    SELECT ${linkAheadRefs.aheadId}, ${input.draftId}::uuid, ${input.documentId}::uuid
    FROM ${linkAheadRefs}
    WHERE ${and(atAddress(input.address), waitingLive())}
    ON CONFLICT DO NOTHING`);
}

/**
 * Refs registered in a draft (an agent's mint in its view, a writer's link in its branch,
 * Apply's cut): each one waiting live settles on the single document its draft has at
 * its address, whether or not the ref was registered before (idempotent per ref and
 * draft). One the draft already settled keeps its first meaning.
 */
export async function settleRegisteredInDrafts(
  db: Database,
  refs: readonly { aheadId: string; draftId: DraftId; address: DocumentCoordinates }[],
): Promise<void> {
  if (refs.length === 0) return;
  const tx = currentDrizzleDb(db);
  const waiting = new Set(
    (
      await tx
        .select({ aheadId: linkAheadRefs.aheadId })
        .from(linkAheadRefs)
        .where(
          and(
            inArray(
              linkAheadRefs.aheadId,
              refs.map((ref) => ref.aheadId),
            ),
            waitingLive(),
          ),
        )
    ).map((row) => row.aheadId),
  );
  const tree = createTreeReader(db);
  const meanings: { aheadId: string; draftId: DraftId; documentId: DocumentId }[] = [];
  for (const draftId of new Set(refs.map((ref) => ref.draftId))) {
    const inDraft = refs.filter((ref) => ref.draftId === draftId && waiting.has(ref.aheadId));
    if (inDraft.length === 0) continue;
    const occupants = await tree.occupantsAt(
      { kind: "draft", draftId },
      inDraft.map((ref) => ref.address),
    );
    for (const { aheadId, address } of inDraft) {
      const ids = occupants.get(coordinatesKey(address)) ?? [];
      const [only] = ids;
      if (only && ids.length === 1) meanings.push({ aheadId, draftId, documentId: only });
    }
  }
  if (meanings.length > 0) {
    await tx.insert(linkAheadDraftSettlements).values(meanings).onConflictDoNothing();
  }
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
