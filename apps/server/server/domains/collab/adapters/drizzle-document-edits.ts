// Immutable edit capture shared by writer inverses and the model stack.
import {
  type CapturedPart,
  captureEditFrontier,
  captureEditParts,
  type EditTarget,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TreeChange, TurnId, UserId } from "@meridian/contracts";
import {
  type Database,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  draftWriteJournal,
  type EditOrigin,
} from "@meridian/database";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { treeChangeFault } from "../domain/tree-inverse.js";

type Db = Pick<Database, "select" | "insert" | "update">;
export interface ReceiptWrite {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
  responseId?: string | null;
  editScopeId?: string | null;
  toolCallId?: string | null;
  actor: "agent" | "human" | "system";
  /** Reserved once by the logical model edit; never allocated at capture. */
  wId?: number;
  actorUserId?: UserId | null;
  kind?: typeof documentEdits.$inferInsert.kind;
  actionId?: string;
  consumes?: string[];
  receipts: (CapturedPart & { origin: EditOrigin; targets?: EditTarget[] })[];
  /** A tree entry: a move, delete, restore or settlement, recorded with no parts. */
  treeChange?: TreeChange;
}

/** Caller holds the authoritative document/draft mutation lock and its event transaction. */
export async function recordDocumentEdit(db: Db, input: ReceiptWrite): Promise<string> {
  if (input.actor === "agent" && input.threadId && input.wId === undefined)
    throw new Error("Model edit capture requires its reserved ordinal");
  const fault = input.treeChange && treeChangeFault(input.treeChange);
  if (fault) throw new Error(fault);
  const wId = input.actor === "agent" ? (input.wId ?? null) : null;
  const [edit] = await db
    .insert(documentEdits)
    .values({
      documentId: input.documentId,
      threadId: input.threadId,
      turnId: input.turnId,
      responseId: input.responseId,
      editScopeId: input.editScopeId,
      toolCallId: input.toolCallId,
      actor: input.actor,
      actorUserId: input.actorUserId,
      kind: input.kind ?? "write",
      wId,
      actionId: input.actionId,
      consumes: input.consumes,
      treeChange: input.treeChange,
    })
    .returning({ id: documentEdits.id });
  if (!edit) throw new Error("Edit receipt was not inserted");
  if (!input.receipts.length) {
    if (!input.treeChange) throw new Error("An edit with no parts must be a tree entry");
    return edit.id;
  }
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
    })),
  );
  for (const [ordinal, p] of input.receipts.entries()) {
    if (p.origin.kind !== "pending") continue;
    await db
      .update(draftWriteJournal)
      .set({
        updateMeta: sql`coalesce(${draftWriteJournal.updateMeta}, '{}'::jsonb) || ${JSON.stringify({ documentEdit: { editId: edit.id, ordinal } })}::jsonb`,
      })
      .where(eq(draftWriteJournal.id, p.origin.rowId));
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
