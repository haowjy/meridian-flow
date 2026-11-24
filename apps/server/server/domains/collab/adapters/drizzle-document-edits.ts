// Immutable edit receipts shared by the model's writes, writer inverses and the model stack.
import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import {
  type Database,
  documentEditParts,
  documentEdits,
  type EditOrigin,
} from "@meridian/database";
import type { StoredEdit } from "@meridian/document-model";
import {
  getDrizzleTransactionLocal,
  setDrizzleTransactionLocal,
} from "../../../shared/drizzle-transaction.js";
import type { EditTarget } from "../domain/turn-inverse-service.js";

type Db = Pick<Database, "insert">;
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
  receipts: {
    origin: EditOrigin;
    targets?: EditTarget[];
    delta?: StoredDelta | null;
    /** An AI write as an Undo-rule edit. */
    write?: { edit: StoredEdit };
  }[];
}

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
      delta: p.delta ?? null,
      targets: p.targets ?? [],
      origin: p.origin,
      ...(p.write ? { edit: p.write.edit } : {}),
    })),
  );
  return edit.id;
}
