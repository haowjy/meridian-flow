// Immutable edit capture and placement shared by writer inverses and the model stack.
import {
  type CapturedPart,
  captureEditFrontier,
  captureEditParts,
  type EditTarget,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { DraftAttributionEdit, DraftEditReveal } from "@meridian/contracts/drafts";
import {
  branchWriteJournal,
  type Database,
  documentBranches,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  drafts,
  type EditOrigin,
  projects,
  threads,
} from "@meridian/database";
import { and, desc, eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type { DraftAttributionStore } from "../domain/ports/draft-attribution-store.js";
import { resolveEditOwners } from "./drizzle-edit-owners.js";

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

/** AI edit parts pending in a branch with the item ranges they inserted and deleted, latest first. */
async function listPendingAgentEdits(
  db: Pick<Database, "select">,
  branchId: string,
): Promise<DraftAttributionEdit[]> {
  const rows = await db
    .select({
      threadId: documentEdits.threadId,
      turnId: documentEdits.turnId,
      toolCallId: branchWriteJournal.toolCallId,
      title: threads.title,
      at: documentEdits.createdAt,
      effect: documentEditParts.effect,
    })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
    .innerJoin(threads, eq(threads.id, documentEdits.threadId))
    // A pending part's placement names the journal row that holds the tool call that wrote it.
    .leftJoin(
      branchWriteJournal,
      sql`${branchWriteJournal.id} = (${documentEditParts.placement}->>'rowId')::bigint`,
    )
    .where(
      and(
        sql`${documentEditParts.placement}->>'kind' = 'pending'`,
        sql`${documentEditParts.placement}->>'branchId' = ${branchId}`,
        eq(documentEdits.actor, "agent"),
      ),
    )
    .orderBy(desc(documentEdits.createdAt), desc(documentEditParts.id));
  const tuple = (r: { client: number; clock: number; len: number }) =>
    [r.client, r.clock, r.len] as [number, number, number];
  const owners = await resolveEditOwners(
    db,
    rows.flatMap((row) => (row.threadId ? [row.threadId] : [])),
  );
  return rows.flatMap((row) => {
    if (!row.threadId || !row.turnId) return [];
    const owner = owners.get(row.threadId);
    const reveal: DraftEditReveal = owner?.spawn ?? {
      threadId: row.threadId,
      turnId: row.turnId,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    };
    return [
      {
        threadId: row.threadId,
        title: row.title ?? "",
        turnId: row.turnId,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        owner: {
          threadId: owner?.threadId ?? row.threadId,
          title: owner?.title ?? row.title ?? "",
          reveal,
        },
        at: row.at.toISOString(),
        inserted: row.effect.inserted.map(tuple),
        deleted: row.effect.deleted.map(tuple),
      },
    ];
  });
}

/** The user who owns the project a text branch's draft belongs to: the author of its browser clients. */
async function projectUserOfBranch(db: Pick<Database, "select">, branchId: string) {
  const [row] = await db
    .select({ userId: projects.userId })
    .from(documentBranches)
    .innerJoin(drafts, eq(drafts.id, documentBranches.draftId))
    .innerJoin(projects, eq(projects.id, drafts.projectId))
    .where(eq(documentBranches.id, branchId))
    .limit(1);
  return row?.userId ?? null;
}

export function createDrizzleDraftAttributionStore(db: Database): DraftAttributionStore {
  return {
    pendingAgentEdits: (branchId) => listPendingAgentEdits(currentDrizzleDb(db), branchId),
    read: (branchId) =>
      runInRootDrizzleReadSnapshot(db, async () => {
        const tx = currentDrizzleDb(db);
        const [branch] = await tx
          .select({ state: documentBranches.state })
          .from(documentBranches)
          .where(eq(documentBranches.id, branchId))
          .limit(1);
        if (!branch) return null;
        const [edits, userId] = await Promise.all([
          listPendingAgentEdits(tx, branchId),
          projectUserOfBranch(tx, branchId),
        ]);
        return { state: branch.state, edits, userId };
      }),
  };
}
