/**
 * What a Draft chat turn's `Restore before` takes back in one draft (design §2), read once for
 * the card's offer and the press: every room the turn wrote the draft's text in, back to the
 * turn's start (`turnSpan`), and the nodes the turn created there, which go to Trash. The draft's
 * text is its fork of each document, or the Live room of a document only the draft holds (a
 * part's `origin` names its draft either way, design §5). A document the turn wrote while only
 * the draft held it, and the writer has since applied, is the manuscript's now: it stays.
 *
 * All or nothing: a draft whose rooms no longer hold the history some span needs (cut at design
 * §4's cutoff) is restored in none of them, so the card offers nothing and a press that comes
 * after the cut restores nothing.
 */
import type { DocumentId, DraftId, TurnId } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import {
  documentEditParts,
  documentEdits,
  draftTreeNodes,
  treeEditReceipts,
} from "@meridian/database/schema";
import {
  decodeRoomVersion,
  holdsSpan,
  type RoomDocs,
  type TurnSpan,
  turnSpan,
} from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";

export type RestorePlan = {
  /** Each room the turn wrote the draft's text in, by document id order. */
  rooms: { documentId: DocumentId; room: DocumentRoom; span: TurnSpan }[];
  /** The nodes the turn created in the draft that only the draft still holds. */
  created: DocumentId[];
};

const onlyInDraft = (draft: DraftId, node: unknown) => sql`EXISTS (
  SELECT 1 FROM ${draftTreeNodes} n
  WHERE n.draft_id = ${draft} AND n.id = ${node} AND n.exists_only_in_draft)`;

export async function restorePlan(
  tx: DrizzleDb,
  turn: TurnId,
  draft: DraftId,
): Promise<RestorePlan> {
  const created = (
    await tx
      .selectDistinct({ node: treeEditReceipts.nodeId })
      .from(treeEditReceipts)
      .where(
        and(
          eq(treeEditReceipts.turnId, turn),
          eq(treeEditReceipts.kind, "write"),
          eq(treeEditReceipts.op, "create"),
          eq(treeEditReceipts.draftId, draft),
          onlyInDraft(draft, treeEditReceipts.nodeId),
        ),
      )
  ).map((row) => row.node as DocumentId);
  const gone = new Set<string>(created);
  const parts = await tx
    .select({
      documentId: documentEdits.documentId,
      kind: sql<"live" | "fork">`${documentEditParts.origin}->>'kind'`,
      before: documentEditParts.before,
      after: documentEditParts.after,
    })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(
      and(
        eq(documentEdits.turnId, turn),
        sql`${documentEditParts.origin}->>'draftId' = ${draft}`,
        isNotNull(documentEditParts.before),
        sql`(${documentEditParts.origin}->>'kind' = 'fork' OR ${onlyInDraft(draft, documentEdits.documentId)})`,
      ),
    )
    .orderBy(asc(documentEditParts.id));
  const writes = new Map<
    string,
    { room: DocumentRoom; writes: Parameters<typeof turnSpan>[0][number][] }
  >();
  for (const part of parts) {
    const documentId = part.documentId as DocumentId;
    if (gone.has(documentId)) continue;
    const room: DocumentRoom =
      part.kind === "fork"
        ? { kind: "fork", draftId: draft, documentId }
        : { kind: "live", documentId };
    const key = `${documentId}:${room.kind}`;
    const entry = writes.get(key) ?? { room, writes: [] };
    entry.writes.push({
      before: decodeRoomVersion(new Uint8Array(part.before as Buffer)),
      after: decodeRoomVersion(new Uint8Array(part.after as Buffer)),
    });
    writes.set(key, entry);
  }
  return {
    rooms: [...writes.values()]
      .map(({ room, writes }) => ({
        documentId: room.documentId as DocumentId,
        room,
        span: turnSpan(writes),
      }))
      .sort((a, b) => a.documentId.localeCompare(b.documentId)),
    created,
  };
}

/**
 * Each of the plan's rooms read, and whether every one holds its span: the caller restores all
 * of them or none, and frees the copies.
 */
export async function readRestore(
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  plan: RestorePlan,
): Promise<{ copies: RoomDocs[]; held: boolean }> {
  const copies: RoomDocs[] = [];
  let held = true;
  try {
    for (const { room, span } of plan.rooms) {
      const copy = await rooms.read(room);
      copies.push(copy);
      held &&= holdsSpan(copy, span);
    }
  } catch (cause) {
    for (const copy of copies) copy.free();
    throw cause;
  }
  return { copies, held };
}

/** The drafts the turn wrote in whose `Restore before` the card offers: each one's plan holds. */
export async function restorableDrafts(
  tx: DrizzleDb,
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  turn: TurnId,
): Promise<DraftId[]> {
  const drafted = await tx.execute<{ draft: string }>(sql`
    SELECT DISTINCT p.origin->>'draftId' AS draft
      FROM ${documentEditParts} p JOIN ${documentEdits} e ON e.id = p.edit_id
      WHERE e.turn_id = ${turn} AND p.origin->>'draftId' IS NOT NULL
        AND EXISTS (SELECT 1 FROM drafts d WHERE d.id = p.origin->>'draftId')
    UNION
    SELECT DISTINCT r.draft_id FROM ${treeEditReceipts} r
      WHERE r.turn_id = ${turn} AND r.kind = 'write' AND r.op = 'create' AND r.draft_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM drafts d WHERE d.id = r.draft_id)
    ORDER BY 1`);
  const out: DraftId[] = [];
  for (const { draft } of drafted) {
    const plan = await restorePlan(tx, turn, draft as DraftId);
    if (!plan.rooms.length && !plan.created.length) continue;
    const { copies, held } = await readRestore(rooms, plan);
    for (const copy of copies) copy.free();
    if (held) out.push(draft as DraftId);
  }
  return out;
}
