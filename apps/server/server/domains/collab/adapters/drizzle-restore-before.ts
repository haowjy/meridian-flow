/**
 * What a Draft chat turn's `Undo turn` takes back in one draft (design §2), read once for
 * the card's offer and the press: the turn's writes into the draft's text, newest first, each in
 * the room it landed in, and the nodes the turn created there, which go to Trash. The draft's text
 * is its fork of each document, or the Live room of a document only the draft holds (a part's
 * `origin` names its draft either way, design §5). A document the turn wrote while only the draft
 * held it, and the writer has since applied, is the manuscript's now: it stays.
 *
 * The writes go back by the one Undo rule (`undoInRooms`), whatever was written since; a write an
 * Undo or the writer's revert already took back is no part of the plan, and one whose history the
 * room cut (design §4's cutoff) stays as it is.
 */
import type { RoomPart } from "@meridian/agent-edit/integration";
import type { CommandId, DocumentId, DraftId, TurnId } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { loroRoomName } from "@meridian/contracts/protocol";
import {
  commands,
  documentEditParts,
  documentEdits,
  draftTreeNodes,
  treeEditReceipts,
} from "@meridian/database/schema";
import { holdsEdit, type RoomDocs, type StoredEdit } from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";

/** One write of the turn into the draft's text, as its Undo takes it back. */
export type RestorePart = RoomPart & { documentId: DocumentId };

export type RestorePlan = {
  /** The turn's writes into the draft's text, newest first. */
  parts: RestorePart[];
  /** The nodes the turn created in the draft that only the draft still holds. */
  created: DocumentId[];
};

const onlyInDraft = (draft: DraftId, node: unknown) => sql`EXISTS (
  SELECT 1 FROM ${draftTreeNodes} n
  WHERE n.draft_id = ${draft} AND n.id = ${node} AND n.exists_only_in_draft)`;

/** A part no Undo, nor the writer's revert, has taken back: taking it back again would put its deleted text back twice. */
const notTakenBack = sql`NOT EXISTS (
  SELECT 1 FROM ${documentEditParts} u JOIN ${documentEdits} e ON e.id = u.edit_id
  WHERE (e.kind = 'undo' OR (e.kind = 'revert' AND e.actor = 'human'))
    AND u.targets @> jsonb_build_array(jsonb_build_object(
      'editId', ${documentEditParts.editId}::text, 'ordinal', ${documentEditParts.ordinal})))`;

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
  const rows = await tx
    .select({
      documentId: documentEdits.documentId,
      kind: sql<"live" | "fork">`${documentEditParts.origin}->>'kind'`,
      edit: documentEditParts.edit,
    })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(
      and(
        eq(documentEdits.turnId, turn),
        sql`${documentEditParts.origin}->>'draftId' = ${draft}`,
        isNotNull(documentEditParts.edit),
        sql`(${documentEditParts.origin}->>'kind' = 'fork' OR ${onlyInDraft(draft, documentEdits.documentId)})`,
        notTakenBack,
      ),
    )
    .orderBy(desc(documentEditParts.id));
  const parts = rows.flatMap((row): RestorePart[] => {
    const documentId = row.documentId as DocumentId;
    if (gone.has(documentId)) return [];
    const room: DocumentRoom =
      row.kind === "fork"
        ? { kind: "fork", draftId: draft, documentId }
        : { kind: "live", documentId };
    return [{ documentId, room, edit: row.edit as StoredEdit }];
  });
  return { parts, created };
}

/**
 * Each room of the plan read once, by room name, forwarded: the caller judges or takes the parts
 * back on them, and frees them.
 */
export async function readRooms(
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  plan: RestorePlan,
): Promise<Map<string, RoomDocs>> {
  const copies = new Map<string, RoomDocs>();
  try {
    for (const { room } of plan.parts) {
      const name = loroRoomName(room);
      if (!copies.has(name)) copies.set(name, await rooms.read(room));
    }
  } catch (cause) {
    for (const copy of copies.values()) copy.free();
    throw cause;
  }
  return copies;
}

/**
 * What the turn card says of `Undo turn` for each draft the turn wrote in: the drafts where
 * pressing it would change something (a write of the turn there would go back, or a node it made
 * would go to Trash), and the restore press in force for each draft, the latest that changed
 * something and has not been undone, so every tab and a reload read the same state.
 */
export async function restoreStates(
  tx: DrizzleDb,
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  turn: TurnId,
): Promise<{ offered: DraftId[]; restored: { draft: DraftId; press: CommandId }[] }> {
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
  const offered: DraftId[] = [];
  const restored: { draft: DraftId; press: CommandId }[] = [];
  for (const { draft } of drafted) {
    const plan = await restorePlan(tx, turn, draft as DraftId);
    const press = await pressInForce(tx, turn, draft as DraftId);
    if (press) restored.push({ draft: draft as DraftId, press });
    else if (plan.created.length || (await someStands(rooms, plan))) offered.push(draft as DraftId);
  }
  return { offered, restored };
}

/** Whether some write of `plan` still stands with the history its Undo needs (`holdsEdit`). */
async function someStands(
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  plan: RestorePlan,
): Promise<boolean> {
  if (!plan.parts.length) return false;
  const copies = await readRooms(rooms, plan);
  try {
    return plan.parts.some(({ room, edit }) =>
      holdsEdit(copies.get(loroRoomName(room)) as RoomDocs, edit),
    );
  } finally {
    for (const copy of copies.values()) copy.free();
  }
}

/** The latest Undo turn of `turn` in `draft` that changed something and was not undone. */
async function pressInForce(
  tx: DrizzleDb,
  turn: TurnId,
  draft: DraftId,
): Promise<CommandId | null> {
  const [row] = await tx
    .select({ id: commands.id })
    .from(commands)
    .where(
      and(
        eq(commands.kind, "press"),
        sql`${commands.outcome}->>'status' = 'done'`,
        sql`${commands.outcome}->'result'->>'verdict' = 'restore'`,
        sql`${commands.outcome}->'result'->'scope'->>'turn' = ${turn}`,
        sql`${commands.outcome}->'result'->'scope'->>'draft' = ${draft}`,
        sql`(jsonb_array_length(${commands.outcome}->'result'->'documents') > 0
          OR jsonb_array_length(${commands.outcome}->'result'->'items') > 0)`,
        sql`NOT EXISTS (SELECT 1 FROM ${commands} u WHERE u.kind = 'unpress'
          AND u.outcome->>'status' = 'done'
          AND u.outcome->'result'->>'pressCommandId' = ${commands.id}::text)`,
      ),
    )
    .orderBy(desc(commands.createdAt))
    .limit(1);
  return row?.id ?? null;
}
