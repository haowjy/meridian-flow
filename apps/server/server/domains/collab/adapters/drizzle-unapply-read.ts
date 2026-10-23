/** Command-scoped receipt and base-effect reads for durable Un-Apply. */
import { applySpanPatches } from "@meridian/agent-edit/diff";
import type { InversePart } from "@meridian/agent-edit/integration";
import type { DocumentId, EditOrigin } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  applyCommandEffects,
  branchCommands,
  documentDrafts,
  documentEditParts,
  documentEdits,
} from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CollabBranches } from "../contracts.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";

const schema = buildDocumentSchema();
type UnapplyClickCommand = Parameters<CollabBranches["draftReview"]["unapplyClick"]>[0];

export async function loadUnapplyHistory(
  db: Database,
  documentId: DocumentId,
  targetSequences: readonly number[],
): Promise<(InversePart & { origin: EditOrigin })[]> {
  if (!targetSequences.length) return [];
  const connection = currentDrizzleDb(db);
  const sequence = sql<number>`((${documentEditParts.origin} ->> 'seq')::bigint)`;
  const targets = await connection
    .select({ id: documentEditParts.id })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEditParts.editId, documentEdits.id))
    .where(
      and(
        eq(documentEdits.documentId, documentId),
        sql`${documentEditParts.origin} ->> 'kind' = 'live'`,
        inArray(sequence, targetSequences),
      ),
    );
  const firstTarget = Math.min(...targets.map((row) => row.id));
  if (!Number.isFinite(firstTarget)) return [];
  const rows = await connection
    .select({
      part: {
        id: documentEditParts.id,
        editId: documentEditParts.editId,
        ordinal: documentEditParts.ordinal,
        update: documentEditParts.update,
        effect: documentEditParts.effect,
        targets: documentEditParts.targets,
        frontier: documentEditParts.frontier,
        aliases: documentEditParts.aliases,
        origin: documentEditParts.origin,
      },
      kind: documentEdits.kind,
      actionId: documentEdits.actionId,
    })
    .from(documentEditParts)
    .innerJoin(documentEdits, eq(documentEditParts.editId, documentEdits.id))
    .where(and(eq(documentEdits.documentId, documentId), gte(documentEditParts.id, firstTarget)))
    .orderBy(documentEditParts.id);
  return rows.map(({ part, kind, actionId }) => ({
    ...part,
    update: new Uint8Array(part.update),
    kind,
    actionId,
  }));
}

export async function loadPreparedUnapply(
  db: Database,
  coordinator: Pick<DraftCoordinator, "loadBase">,
  command: UnapplyClickCommand,
) {
  const tx = currentDrizzleDb(db);
  const rows = await tx
    .select({
      branchId: branchCommands.branchId,
      ordinal: applyCommandEffects.ordinal,
      groupId: applyCommandEffects.groupId,
      draftId: applyCommandEffects.draftId,
      documentId: applyCommandEffects.documentId,
      liveUpdateSeq: applyCommandEffects.liveUpdateSeq,
      baseStart: applyCommandEffects.baseStart,
      baseDelta: applyCommandEffects.baseDelta,
    })
    .from(applyCommandEffects)
    .innerJoin(branchCommands, eq(branchCommands.id, applyCommandEffects.commandId))
    .where(
      and(
        eq(applyCommandEffects.commandId, command.request.applyCommandId),
        eq(applyCommandEffects.documentId, command.documentId),
        isNull(applyCommandEffects.unappliedBy),
        eq(branchCommands.workId, command.workId),
        eq(branchCommands.accountId, command.envelope.accountId),
        eq(branchCommands.kind, "apply_click"),
        eq(branchCommands.state, "done"),
      ),
    )
    .orderBy(applyCommandEffects.ordinal);
  const first = rows[0];
  if (!first?.branchId || rows.some((row) => row.draftId !== first.draftId)) return null;
  try {
    const base = await coordinator.loadBase(first.draftId);
    if (
      base.snapshot.status === "closed" ||
      base.snapshot.documentId !== command.documentId ||
      base.snapshot.branchId !== first.branchId
    )
      return null;
    const effects: {
      ordinal: number;
      groupId: string;
      liveUpdateSeq: number | null;
      baseBefore: unknown[];
      baseAfter: unknown[];
    }[] = [];
    let preceding = first.baseStart?.map((node) => schema.nodeFromJSON(node));
    if (!preceding) return null;
    for (const row of rows) {
      const following = applySpanPatches(
        preceding,
        (row.baseDelta as import("@meridian/agent-edit/diff").SpanPatch[]).map((patch) => ({
          ...patch,
          blocks: patch.blocks.map((node) => schema.nodeFromJSON(node)),
        })),
        "base",
      );
      effects.push({
        ordinal: row.ordinal,
        groupId: row.groupId,
        liveUpdateSeq: row.liveUpdateSeq,
        baseBefore: preceding.map((node) => node.toJSON()),
        baseAfter: following.map((node) => node.toJSON()),
      });
      preceding = following;
    }
    return { base, branchId: first.branchId, effects };
  } catch (cause) {
    const [draft] = await tx
      .select({ status: documentDrafts.status })
      .from(documentDrafts)
      .where(eq(documentDrafts.id, first.draftId));
    if (!draft || draft.status === "closed") return null;
    throw cause;
  }
}
