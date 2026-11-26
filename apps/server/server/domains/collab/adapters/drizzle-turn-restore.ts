import type { RoomPart } from "@meridian/agent-edit/integration";
import type { CommandId, DocumentId, DraftId, EditOrigin, TurnId } from "@meridian/contracts";
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
import { newestDrafted, pendingRecords } from "@meridian/project-tree";
import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListsOfDraft } from "./drizzle-draft-tree-lists.js";

export type RestorePart = RoomPart & {
  documentId: DocumentId;
  editId: string;
  ordinal: number;
  origin: EditOrigin;
};

export type RestorePlan = {
  parts: RestorePart[];
  records: string[];
  nodes: DocumentId[];
};

type TreeReader = Pick<TreeListStore, "read">;

const onlyInDraft = (draft: DraftId, node: unknown) => sql`EXISTS (
  SELECT 1 FROM ${draftTreeNodes} n
  WHERE n.draft_id = ${draft} AND n.id = ${node} AND n.exists_only_in_draft)`;

const notTakenBack = (ownTurn?: TurnId) => sql`NOT EXISTS (
  SELECT 1 FROM ${documentEditParts} u JOIN ${documentEdits} e ON e.id = u.edit_id
  WHERE (e.kind = 'undo' OR (e.kind = 'revert' AND e.actor = 'human'))
    ${ownTurn ? sql`AND e.turn_id IS DISTINCT FROM ${ownTurn}` : sql``}
    AND u.targets @> jsonb_build_array(jsonb_build_object(
      'editId', ${documentEditParts.editId}::text, 'ordinal', ${documentEditParts.ordinal})))`;

export async function restorePlan(
  tx: DrizzleDb,
  treeLists: TreeReader,
  turn: TurnId,
  draft: DraftId,
): Promise<RestorePlan> {
  const tree = await pendingOfTurn(tx, treeLists, turn, draft);
  const gone = new Set<string>(tree.created);
  const parts = (
    await standingParts(
      tx,
      and(
        eq(documentEdits.turnId, turn),
        sql`${documentEditParts.origin}->>'draftId' = ${draft}`,
        sql`(${documentEditParts.origin}->>'kind' = 'fork' OR ${onlyInDraft(draft, documentEdits.documentId)})`,
      ),
      notTakenBack(turn),
    )
  ).filter((part) => !gone.has(part.documentId));
  return { parts, records: tree.records, nodes: tree.nodes };
}

export function restoredParts(tx: DrizzleDb, press: CommandId): Promise<RestorePart[]> {
  return standingParts(
    tx,
    and(
      eq(documentEdits.commandId, press),
      eq(documentEdits.kind, "undo"),
      eq(documentEdits.actor, "human"),
    ),
    notTakenBack(),
  );
}

async function standingParts(
  tx: DrizzleDb,
  where: SQL | undefined,
  stands: SQL,
): Promise<RestorePart[]> {
  const rows = await tx
    .select({
      documentId: documentEdits.documentId,
      editId: documentEditParts.editId,
      ordinal: documentEditParts.ordinal,
      origin: documentEditParts.origin,
      edit: documentEditParts.edit,
    })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .where(and(where, isNotNull(documentEditParts.edit), stands))
    .orderBy(desc(documentEditParts.id));
  return rows.map((row) => {
    const documentId = row.documentId as DocumentId;
    const room: DocumentRoom =
      row.origin.kind === "fork"
        ? { kind: "fork", draftId: row.origin.draftId, documentId }
        : { kind: "live", documentId };
    return { ...row, documentId, room, edit: row.edit as StoredEdit };
  });
}

async function pendingOfTurn(
  tx: DrizzleDb,
  treeLists: TreeReader,
  turn: TurnId,
  draft: DraftId,
): Promise<{ records: string[]; nodes: DocumentId[]; created: DocumentId[] }> {
  const receipts = await tx
    .select({ records: treeEditReceipts.records })
    .from(treeEditReceipts)
    .where(
      and(
        eq(treeEditReceipts.turnId, turn),
        eq(treeEditReceipts.kind, "write"),
        eq(treeEditReceipts.draftId, draft),
      ),
    );
  const ids = receipts.flatMap((receipt) => receipt.records.map((entry) => entry.record));
  if (!ids.length) return { records: [], nodes: [], created: [] };
  return treeLists.read({
    lists: await treeListsOfDraft(tx, draft),
    view: (ends) => {
      const records: string[] = [];
      const nodes = new Set<DocumentId>();
      const created: DocumentId[] = [];
      for (const { writer } of ends) {
        const newest = new Set([...newestDrafted(writer.doc, ids).values()].map((r) => r.id));
        for (const record of pendingRecords(writer.doc, draft)) {
          if (!newest.has(record.id)) continue;
          records.push(record.id);
          nodes.add(record.node as DocumentId);
          if (record.type === "create") created.push(record.node as DocumentId);
        }
      }
      return { records, nodes: [...nodes].sort(), created };
    },
  });
}

export async function readRooms(
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  parts: readonly RoomPart[],
): Promise<Map<string, RoomDocs>> {
  const copies = new Map<string, RoomDocs>();
  try {
    for (const { room } of parts) {
      const name = loroRoomName(room);
      if (!copies.has(name)) copies.set(name, await rooms.read(room));
    }
  } catch (cause) {
    for (const copy of copies.values()) copy.free();
    throw cause;
  }
  return copies;
}

export async function restoreStates(
  tx: DrizzleDb,
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  treeLists: TreeReader,
  turn: TurnId,
): Promise<{ offered: DraftId[]; restored: { draft: DraftId; press: CommandId }[] }> {
  const drafted = await tx.execute<{ draft: string }>(sql`
    SELECT DISTINCT p.origin->>'draftId' AS draft
      FROM ${documentEditParts} p JOIN ${documentEdits} e ON e.id = p.edit_id
      WHERE e.turn_id = ${turn} AND p.origin->>'draftId' IS NOT NULL
        AND EXISTS (SELECT 1 FROM drafts d WHERE d.id = p.origin->>'draftId')
    UNION
    SELECT DISTINCT r.draft_id FROM ${treeEditReceipts} r
      WHERE r.turn_id = ${turn} AND r.kind = 'write' AND r.draft_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM drafts d WHERE d.id = r.draft_id)
    ORDER BY 1`);
  const offered: DraftId[] = [];
  const restored: { draft: DraftId; press: CommandId }[] = [];
  for (const { draft } of drafted) {
    const press = await pressInForce(tx, turn, draft as DraftId);
    if (press) {
      restored.push({ draft: draft as DraftId, press });
      continue;
    }
    const plan = await restorePlan(tx, treeLists, turn, draft as DraftId);
    if (plan.records.length || (await someStands(rooms, plan))) offered.push(draft as DraftId);
  }
  return { offered, restored };
}

async function someStands(
  rooms: Pick<DocumentRooms<DrizzleDb>, "read">,
  plan: RestorePlan,
): Promise<boolean> {
  if (!plan.parts.length) return false;
  const copies = await readRooms(rooms, plan.parts);
  try {
    return plan.parts.some(({ room, edit }) =>
      holdsEdit(copies.get(loroRoomName(room)) as RoomDocs, edit),
    );
  } finally {
    for (const copy of copies.values()) copy.free();
  }
}

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
