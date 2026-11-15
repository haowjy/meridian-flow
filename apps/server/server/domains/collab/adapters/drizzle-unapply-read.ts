/** Command-scoped receipt and base-effect reads for durable Un-Apply. */
import { applySpanPatches, type SpanPatch } from "@meridian/agent-edit/diff";
import type { InversePart } from "@meridian/agent-edit/integration";
import { type DocumentId, type EditOrigin, parseDraftItemKey } from "@meridian/contracts";
import type { ApplyClickResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import {
  applyCommandEffects,
  applyCommandTrees,
  commands,
  documentDrafts,
  documentEditParts,
  documentEdits,
} from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Node } from "prosemirror-model";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { CollabBranches } from "../contracts.js";
import type { PreparedUnapply } from "../domain/apply-click.js";

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

type EffectRow = {
  ordinal: number;
  groupId: string;
  liveUpdateSeq: number | null;
  baseStart: unknown[] | null;
  baseDelta: unknown;
};

/**
 * Each effect's base before and after it, for one Apply's rows on one document in ordinal order.
 * Every row advances the chain, a reversed one included: `baseStart` is stored once, on the first
 * row. Null when the first row has no start.
 */
export function effectBases<Row extends EffectRow>(
  rows: readonly Row[],
): { row: Row; baseBefore: unknown[]; baseAfter: unknown[] }[] | null {
  let preceding = rows[0]?.baseStart?.map((node) => schema.nodeFromJSON(node));
  if (!preceding) return null;
  return rows.map((row) => {
    const following = applySpanPatches(
      preceding as Node[],
      (row.baseDelta as SpanPatch[]).map((patch) => ({
        ...patch,
        blocks: patch.blocks.map((node) => schema.nodeFromJSON(node)),
      })),
      "base",
    );
    const out = {
      row,
      baseBefore: (preceding as Node[]).map((node) => node.toJSON()),
      baseAfter: following.map((node) => node.toJSON()),
    };
    preceding = following;
    return out;
  });
}

/**
 * The documents the Apply's stored answer says it moved, deleted or created, when no tree row
 * of it is left: a Work's purge deletes the rows with its branches, and the tree half they
 * described cannot come back.
 */
async function treeHalfLostWithBranch(
  tx: ReturnType<typeof currentDrizzleDb>,
  applyCommandId: string,
  accountId: string,
): Promise<string[]> {
  const [row] = await tx
    .select({ outcome: commands.outcome })
    .from(commands)
    .where(
      and(
        eq(commands.id, applyCommandId),
        eq(commands.accountId, accountId),
        eq(commands.kind, "apply"),
      ),
    );
  const result =
    row?.outcome.status === "never"
      ? undefined
      : (row?.outcome.result as ApplyClickResult | undefined);
  return (result?.applied ?? []).flatMap((item) => {
    const documentId = item.transition && parseDraftItemKey(item.itemKey)?.documentId;
    return documentId ? [documentId] : [];
  });
}

/**
 * The command's effects, read for the account that sent it: the text effects of
 * each document it wrote, and its tree half. Keyed by the Apply, not by a branch: a Restore moves
 * a draft to another branch, a delete's Apply closes it. The draft's state is read by `unapply`
 * under its locks. Null when the command has no effect here.
 */
export async function loadPreparedUnapply(
  db: Database,
  command: UnapplyClickCommand,
): Promise<PreparedUnapply | null> {
  const tx = currentDrizzleDb(db);
  const applied = command.request.applyCommandId;
  const ownApply = and(
    eq(commands.accountId, command.envelope.accountId),
    eq(commands.kind, "apply"),
  );
  const trees = await tx
    .select({
      branchId: applyCommandTrees.branchId,
      scope: applyCommandTrees.scope,
      mark: applyCommandTrees.mark,
      createdHeads: applyCommandTrees.createdHeads,
      restored: applyCommandTrees.restored,
    })
    .from(applyCommandTrees)
    .innerJoin(commands, eq(commands.id, applyCommandTrees.commandId))
    .where(and(eq(applyCommandTrees.commandId, applied), ownApply));
  const rows = await tx
    .select({
      draftBranchId: documentDrafts.branchId,
      ordinal: applyCommandEffects.ordinal,
      groupId: applyCommandEffects.groupId,
      draftId: applyCommandEffects.draftId,
      documentId: applyCommandEffects.documentId,
      liveUpdateSeq: applyCommandEffects.liveUpdateSeq,
      baseStart: applyCommandEffects.baseStart,
      baseDelta: applyCommandEffects.baseDelta,
      unappliedBy: applyCommandEffects.unappliedBy,
    })
    .from(applyCommandEffects)
    .innerJoin(commands, eq(commands.id, applyCommandEffects.commandId))
    .leftJoin(documentDrafts, eq(documentDrafts.id, applyCommandEffects.draftId))
    .where(and(eq(applyCommandEffects.commandId, applied), ownApply))
    .orderBy(applyCommandEffects.documentId, applyCommandEffects.ordinal);
  const branchId = trees[0]?.branchId ?? rows[0]?.draftBranchId ?? command.branchId;
  const treeLost = trees.length
    ? []
    : await treeHalfLostWithBranch(tx, applied, command.envelope.accountId);
  if (!rows.length)
    return trees.length || treeLost.length ? { branchId, texts: [], trees, treeLost } : null;
  const texts: PreparedUnapply["texts"] = [];
  for (const documentId of new Set(rows.map((row) => row.documentId))) {
    const own = rows.filter((row) => row.documentId === documentId);
    const [first] = own;
    if (!first || own.some((row) => row.draftId !== first.draftId)) return null;
    const bases = effectBases(own);
    if (!bases) return null;
    texts.push({
      draftId: first.draftId,
      documentId: first.documentId,
      effects: bases.flatMap(({ row, baseBefore, baseAfter }) =>
        row.unappliedBy === null
          ? [
              {
                ordinal: row.ordinal,
                groupId: row.groupId,
                liveUpdateSeq: row.liveUpdateSeq,
                baseBefore,
                baseAfter,
              },
            ]
          : [],
      ),
    });
  }
  return { branchId, texts, trees, treeLost };
}
