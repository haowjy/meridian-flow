// Immutable edit capture shared by writer inverses and the model stack.
import { captureDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import { heldBlocks } from "@meridian/agent-edit/diff";
import {
  type CapturedPart,
  captureEditParts,
  type EditTarget,
  heldDeletes,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import {
  type Database,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  type EditOrigin,
} from "@meridian/database";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import {
  getDrizzleTransactionLocal,
  setDrizzleTransactionLocal,
} from "../../../shared/drizzle-transaction.js";

type Db = Pick<Database, "select" | "insert" | "update">;
export interface ReceiptWrite {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  turnId?: TurnId | null;
  responseId?: string | null;
  commandId?: string;
  toolCallId?: string | null;
  actor: "agent" | "human" | "system";
  /** Reserved once by the logical model edit; never allocated at capture. */
  wId?: number;
  actorUserId?: UserId | null;
  kind?: typeof documentEdits.$inferInsert.kind;
  actionId?: string;
  receipts: (CapturedPart & {
    origin: EditOrigin;
    targets?: EditTarget[];
    delta?: StoredDelta | null;
  })[];
}

const deltaSchema = buildDocumentSchema();

const modelEditCommand = { name: "model-edit-command" };

/**
 * Every edit receipt recorded in the ambient transaction names this command, so the model's text
 * receipts and its tree entries carry the id of the one command that made them without each
 * writer threading it through.
 */
export function bindEditsToCommand(commandId: string): void {
  setDrizzleTransactionLocal(modelEditCommand, commandId);
}

/** The command the ambient transaction runs, for a receipt that is not an edit's (a tree receipt). */
export function boundCommandId(): string | undefined {
  return getDrizzleTransactionLocal<string>(modelEditCommand);
}

/** Caller holds the authoritative document/draft mutation lock and its event transaction. */
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
      commandId: input.commandId ?? boundCommandId(),
      toolCallId: input.toolCallId,
      actor: input.actor,
      actorUserId: input.actorUserId,
      kind: input.kind ?? "write",
      wId,
      actionId: input.actionId,
    })
    .returning({ id: documentEdits.id });
  if (!edit) throw new Error("Edit receipt was not inserted");
  if (!input.receipts.length) return edit.id;
  await db.insert(documentEditParts).values(
    input.receipts.map((p, ordinal) => ({
      editId: edit.id,
      ordinal,
      update: Buffer.from(p.update),
      effect: p.effect,
      delta: p.delta ?? null,
      targets: p.targets ?? [],
      origin: p.origin,
    })),
  );
  for (const seq of new Set(input.receipts.map((p) => p.origin.seq))) {
    await db
      .update(documentYjsUpdates)
      .set({ editId: edit.id })
      .where(eq(documentYjsUpdates.id, seq));
  }
  return edit.id;
}
/**
 * Authoritative pre-write state plus transaction deltas, never a state-vector diff. A delete of
 * an item the room had already deleted when the row applied is not the row's effect, whether the
 * author read a stale view or the writer's delete landed after the call. `withDelta` reads each
 * row's text before and after it, for a receipt of an AI write or an Undo that can be undone.
 */
export function captureReceiptRows(
  doc: Y.Doc,
  rows: readonly { update: Uint8Array; origin: EditOrigin }[],
  withDelta: boolean,
): (ReceiptWrite["receipts"][number] & { held: ReadonlySet<string> })[] {
  const blocks = withDelta ? heldBlocks(doc, deltaSchema, "readBlocks") : null;
  let textBefore = blocks?.all() ?? null;
  const receipts = rows.map((row) => {
    const held = heldDeletes(doc, row.update, Y.decodeStateVector(Y.encodeStateVector(doc)));
    Y.applyUpdate(doc, row.update);
    const textAfter = blocks?.all() ?? null;
    const delta = textBefore && textAfter ? captureDelta(textBefore, textAfter) : null;
    textBefore = textAfter;
    return { ...row, held, delta };
  });
  return receipts.map((receipt, i) => ({
    ...captureEditParts(doc, [receipt])[0],
    origin: rows[i].origin,
    held: receipt.held,
    delta: receipt.delta,
  }));
}

/** Names the command on the receipts of the live updates it appended (rows already recorded). */
export async function stampLiveEditsWithCommand(
  db: Db,
  commandId: string,
  seqs: readonly number[],
): Promise<void> {
  if (!seqs.length) return;
  await db
    .update(documentEdits)
    .set({ commandId })
    .where(
      inArray(
        documentEdits.id,
        db
          .select({ id: documentYjsUpdates.editId })
          .from(documentYjsUpdates)
          .where(inArray(documentYjsUpdates.id, [...seqs])),
      ),
    );
}
