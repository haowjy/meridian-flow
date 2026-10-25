/** Branch-local sibling ranks; live placement remains untouched until Apply. */
import type { BranchId, ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  branchTreeParentOrders,
  branchTreeRanks,
  contextSources,
  documents,
  folders,
} from "@meridian/database/schema";
import { compareDefaultSiblings } from "@meridian/resource-replica";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { visibleDocuments, visibleFolders } from "./tree-view-sql.js";

type Sibling = { kind: "document" | "folder"; id: string; name: string; rank: string | null };

export async function placeBranchSibling(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    position?: ContextSiblingPosition;
    arrived: boolean;
  },
): Promise<string | null | "stale-anchor"> {
  const tx = currentDrizzleDb(db);
  const view = { kind: "branch" as const, branchId: input.branchId };
  const vd = visibleDocuments(view);
  const vf = visibleFolders(view);
  const [documentRows, folderRows] = await Promise.all([
    tx
      .select({ id: vd.id, name: vd.name, extension: vd.extension, rank: vd.rank })
      .from(vd)
      .where(
        and(
          eq(vd.contextSourceId, input.sourceId),
          input.parentId === null ? isNull(vd.folderId) : eq(vd.folderId, input.parentId),
        ),
      ),
    tx
      .select({ id: vf.id, name: vf.name, rank: vf.rank })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, input.sourceId),
          input.parentId === null ? isNull(vf.parentId) : eq(vf.parentId, input.parentId),
        ),
      ),
  ]);
  let rows: Sibling[] = [
    ...folderRows.map((row) => ({ kind: "folder" as const, ...row })),
    ...documentRows.map((row) => ({
      kind: "document" as const,
      id: row.id,
      name: row.extension ? `${row.name}.${row.extension}` : row.name,
      rank: row.rank,
    })),
  ];
  const overrides = rows.length
    ? await tx
        .select({ nodeId: branchTreeRanks.nodeId, rank: branchTreeRanks.rank })
        .from(branchTreeRanks)
        .where(
          and(
            eq(branchTreeRanks.branchId, input.branchId),
            inArray(
              branchTreeRanks.nodeId,
              rows.map((row) => row.id),
            ),
          ),
        )
    : [];
  const rankById = new Map(overrides.map((row) => [row.nodeId, row.rank]));
  rows = rows.map((row) => ({ ...row, rank: rankById.get(row.id) ?? row.rank }));
  const parentKey = input.parentId ?? input.sourceId;
  const [branchPolicy] = await tx
    .select({ orderPolicy: branchTreeParentOrders.orderPolicy })
    .from(branchTreeParentOrders)
    .where(
      and(
        eq(branchTreeParentOrders.branchId, input.branchId),
        eq(branchTreeParentOrders.parentKind, input.parentId === null ? "source" : "folder"),
        eq(branchTreeParentOrders.parentId, parentKey),
      ),
    );
  let manual = branchPolicy?.orderPolicy === "manual";
  if (!branchPolicy) {
    const [liveParent] =
      input.parentId === null
        ? await tx
            .select({ orderPolicy: contextSources.orderPolicy })
            .from(contextSources)
            .where(eq(contextSources.id, input.sourceId))
        : await tx
            .select({ orderPolicy: folders.orderPolicy })
            .from(folders)
            .where(eq(folders.id, input.parentId));
    manual = liveParent?.orderPolicy === "manual";
  }
  if (input.position && !manual) {
    rows.sort((left, right) =>
      compareDefaultSiblings(
        { kind: left.kind === "folder" ? "folder" : "file", name: left.name, identity: left.id },
        { kind: right.kind === "folder" ? "folder" : "file", name: right.name, identity: right.id },
      ),
    );
    const ranks = generateNKeysBetween(null, null, rows.length);
    for (const [index, row] of rows.entries()) {
      const rank = ranks[index] as string;
      row.rank = rank;
      await tx
        .insert(branchTreeRanks)
        .values({ branchId: input.branchId, nodeKind: row.kind, nodeId: row.id, rank })
        .onConflictDoUpdate({
          target: [branchTreeRanks.branchId, branchTreeRanks.nodeKind, branchTreeRanks.nodeId],
          set: { rank, updatedAt: new Date() },
        });
    }
    await tx
      .insert(branchTreeParentOrders)
      .values({
        branchId: input.branchId,
        parentKind: input.parentId === null ? "source" : "folder",
        parentId: parentKey,
        orderPolicy: "manual",
      })
      .onConflictDoUpdate({
        target: [
          branchTreeParentOrders.branchId,
          branchTreeParentOrders.parentKind,
          branchTreeParentOrders.parentId,
        ],
        set: { orderPolicy: "manual", updatedAt: new Date() },
      });
    manual = true;
  }
  if (!manual) return null;
  const moving = rows.find((row) => row.id === input.documentId);
  if (!moving) throw new Error("Branch placement is absent from its destination parent");
  if (!input.position && !input.arrived) return moving.rank;
  const others = rows
    .filter((row) => row.id !== input.documentId)
    .sort((left, right) => ((left.rank as string) < (right.rank as string) ? -1 : 1));
  let index = others.length;
  if (input.position?.kind === "start") index = 0;
  else if (input.position && "siblingId" in input.position) {
    const position = input.position;
    const anchor = others.findIndex((row) => row.id === position.siblingId);
    if (anchor < 0) return "stale-anchor";
    index = position.kind === "before" ? anchor : anchor + 1;
  }
  const rank = generateKeyBetween(others[index - 1]?.rank ?? null, others[index]?.rank ?? null);
  await tx
    .insert(branchTreeRanks)
    .values({ branchId: input.branchId, nodeKind: "document", nodeId: input.documentId, rank })
    .onConflictDoUpdate({
      target: [branchTreeRanks.branchId, branchTreeRanks.nodeKind, branchTreeRanks.nodeId],
      set: { rank, updatedAt: new Date() },
    });
  return rank;
}

/** Restore one document to the placement the branch inherited before its drafted reorder. */
export async function restoreBranchSibling(
  db: Database,
  input: { branchId: BranchId; documentId: DocumentId },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const [document] = await tx
    .select({
      sourceId: documents.contextSourceId,
      parentId: documents.folderId,
      rank: documents.rank,
    })
    .from(documents)
    .where(eq(documents.id, input.documentId));
  if (!document) return;
  const [parent] =
    document.parentId === null
      ? await tx
          .select({ orderPolicy: contextSources.orderPolicy })
          .from(contextSources)
          .where(eq(contextSources.id, document.sourceId))
      : await tx
          .select({ orderPolicy: folders.orderPolicy })
          .from(folders)
          .where(eq(folders.id, document.parentId));
  let rank = document.rank;
  if (parent?.orderPolicy !== "manual") {
    const view = { kind: "branch" as const, branchId: input.branchId };
    const vd = visibleDocuments(view);
    const vf = visibleFolders(view);
    const [documentRows, folderRows] = await Promise.all([
      tx
        .select({ id: vd.id, name: vd.name, extension: vd.extension })
        .from(vd)
        .where(
          and(
            eq(vd.contextSourceId, document.sourceId),
            document.parentId === null ? isNull(vd.folderId) : eq(vd.folderId, document.parentId),
          ),
        ),
      tx
        .select({ id: vf.id, name: vf.name })
        .from(vf)
        .where(
          and(
            eq(vf.contextSourceId, document.sourceId),
            document.parentId === null ? isNull(vf.parentId) : eq(vf.parentId, document.parentId),
          ),
        ),
    ]);
    const rows = [
      ...folderRows.map((row) => ({ kind: "folder" as const, ...row })),
      ...documentRows.map((row) => ({
        kind: "document" as const,
        id: row.id,
        name: row.extension ? `${row.name}.${row.extension}` : row.name,
      })),
    ].sort((left, right) =>
      compareDefaultSiblings(
        { kind: left.kind === "folder" ? "folder" : "file", name: left.name, identity: left.id },
        { kind: right.kind === "folder" ? "folder" : "file", name: right.name, identity: right.id },
      ),
    );
    const index = rows.findIndex((row) => row.id === input.documentId);
    if (index < 0) return;
    rank = generateNKeysBetween(null, null, rows.length)[index] as string;
  }
  if (rank === null) {
    await tx
      .delete(branchTreeRanks)
      .where(
        and(
          eq(branchTreeRanks.branchId, input.branchId),
          eq(branchTreeRanks.nodeKind, "document"),
          eq(branchTreeRanks.nodeId, input.documentId),
        ),
      );
    return;
  }
  await tx
    .insert(branchTreeRanks)
    .values({
      branchId: input.branchId,
      nodeKind: "document",
      nodeId: input.documentId,
      rank,
    })
    .onConflictDoUpdate({
      target: [branchTreeRanks.branchId, branchTreeRanks.nodeKind, branchTreeRanks.nodeId],
      set: { rank, updatedAt: new Date() },
    });
}
