// Immutable edit capture and placement shared by writer inverses and the model stack.
import {
  type CapturedPart,
  captureEditFrontier,
  captureEditParts,
  type EditTarget,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import {
  branchWriteJournal,
  type Database,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  type EditOrigin,
  type EditPlacement,
  documentBranches as importedDocumentBranches,
} from "@meridian/database";
import { and, eq, sql } from "drizzle-orm";
import * as Y from "yjs";

type Db = Pick<Database, "select" | "insert" | "update">;
export interface ReceiptWrite {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
  responseId?: string | null;
  editScopeId?: string | null;
  actor: "agent" | "human" | "system";
  /** Reserved once by the logical model edit; never allocated at capture. */
  wId?: number;
  actorUserId?: UserId | null;
  kind?: typeof documentEdits.$inferInsert.kind;
  receipts: (CapturedPart & { origin: EditOrigin; targets?: EditTarget[] })[];
}
/** Caller holds the authoritative document/branch mutation lock and its event transaction. */
export async function recordDocumentEdit(db: Db, input: ReceiptWrite): Promise<string> {
  if (input.actor === "agent" && input.threadId && input.wId === undefined)
    throw new Error("Model edit capture requires its reserved ordinal");
  const wId = input.actor === "agent" ? (input.wId ?? null) : null;
  const [edit] = await db
    .insert(documentEdits)
    .values({
      documentId: input.documentId,
      threadId: input.threadId,
      turnId: input.turnId,
      responseId: input.responseId,
      editScopeId: input.editScopeId,
      actor: input.actor,
      actorUserId: input.actorUserId,
      kind: input.kind ?? "write",
      wId,
    })
    .returning({ id: documentEdits.id });
  if (!edit) throw new Error("Edit receipt was not inserted");
  await db.insert(documentEditParts).values(
    input.receipts.map((p, ordinal) => ({
      editId: edit.id,
      ordinal,
      update: Buffer.from(p.update),
      effect: p.effect,
      frontier: p.frontier,
      aliases: p.aliases,
      targets: p.targets ?? [],
      origin: p.origin,
      placement: p.origin,
    })),
  );
  for (const [ordinal, p] of input.receipts.entries()) {
    if (p.origin.kind !== "pending") continue;
    await db
      .update(branchWriteJournal)
      .set({
        updateMeta: sql`coalesce(${branchWriteJournal.updateMeta}, '{}'::jsonb) || ${JSON.stringify({ documentEdit: { editId: edit.id, ordinal } })}::jsonb`,
      })
      .where(eq(branchWriteJournal.id, p.origin.rowId));
  }
  const live = input.receipts.filter((p) => p.origin.kind === "live");
  for (const seq of new Set(live.map((p) => (p.origin.kind === "live" ? p.origin.seq : 0)))) {
    const ordinals = input.receipts.flatMap((p, ordinal) =>
      p.origin.kind === "live" && p.origin.seq === seq ? [ordinal] : [],
    );
    await db
      .update(documentYjsUpdates)
      .set({ editId: edit.id, editPartOrdinal: ordinals.length === 1 ? ordinals[0] : null })
      .where(eq(documentYjsUpdates.id, seq));
  }
  return edit.id;
}
/** Authoritative pre-write state plus transaction deltas, never a state-vector diff. */
export function captureReceiptRows(
  doc: Y.Doc,
  rows: readonly { update: Uint8Array; origin: EditOrigin }[],
): ReceiptWrite["receipts"] {
  const receipts = rows.map((row) => {
    const frontier = captureEditFrontier(doc);
    Y.applyUpdate(doc, row.update);
    return { ...row, frontier };
  });
  return receipts.map((receipt, i) => ({
    ...captureEditParts(doc, [receipt])[0],
    origin: rows[i].origin,
  }));
}
export async function placeDraftRows(
  db: Db,
  branchId: string,
  generation: number,
  rowIds: readonly number[],
  placement: EditPlacement,
): Promise<void> {
  if (!rowIds.length) return;
  const placed = await db
    .update(documentEditParts)
    .set({ placement })
    .where(
      and(
        sql`${documentEditParts.placement}->>'kind' = 'pending'`,
        sql`${documentEditParts.placement}->>'branchId' = ${branchId}`,
        sql`(${documentEditParts.placement}->>'generation')::integer = ${generation}`,
        sql`(${documentEditParts.placement}->>'rowId')::bigint IN (${sql.join(
          rowIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      ),
    )
    .returning({ editId: documentEditParts.editId, ordinal: documentEditParts.ordinal });
  if (placed.length)
    await db
      .update(importedDocumentBranches)
      .set({ blocking: false })
      .where(eq(importedDocumentBranches.id, branchId));
  if (placement.kind === "live" && placed.length === 1) {
    await db
      .update(documentYjsUpdates)
      .set({ editId: placed[0].editId, editPartOrdinal: placed[0].ordinal })
      .where(eq(documentYjsUpdates.id, placement.seq));
  }
}
/** Mark the closed branches' pending edit parts discarded, so model `write undo` names the skip. */
export async function discardDraftEditParts(db: Db, branchIds: readonly string[]): Promise<void> {
  if (branchIds.length === 0) return;
  await db
    .update(documentEditParts)
    .set({ placement: { kind: "discarded" } })
    .where(
      and(
        sql`${documentEditParts.placement}->>'kind' = 'pending'`,
        sql`${documentEditParts.placement}->>'branchId' IN (${sql.join(
          branchIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      ),
    );
}
