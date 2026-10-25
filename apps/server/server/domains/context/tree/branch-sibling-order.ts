/** Branch-local sibling order, from allocation through settlement and live reconciliation. */
import type {
  BranchId,
  BranchTreeFacts,
  ContextSourceId,
  DocumentId,
  FolderId,
} from "@meridian/contracts";
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  branchTreeChanges,
  branchTreeParentOrders,
  branchTreeRanks,
  contextSources,
  documents,
  folders,
} from "@meridian/database/schema";
import { compareDefaultSiblings } from "@meridian/resource-replica";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { visibleDocuments, visibleFolders } from "./tree-view-sql.js";

type Sibling = { kind: "document" | "folder"; id: string; name: string; rank: string | null };
type Parent = {
  kind: "source" | "folder";
  id: ContextSourceId | FolderId;
  sourceId: ContextSourceId;
  folderId: FolderId | null;
};

function parentOf(sourceId: ContextSourceId, folderId: FolderId | null): Parent {
  return folderId === null
    ? { kind: "source", id: sourceId, sourceId, folderId }
    : { kind: "folder", id: folderId, sourceId, folderId };
}

async function parentPolicy(db: Database, branchId: BranchId, parent: Parent) {
  const tx = currentDrizzleDb(db);
  const [branch] = await tx
    .select({ orderPolicy: branchTreeParentOrders.orderPolicy })
    .from(branchTreeParentOrders)
    .where(
      and(
        eq(branchTreeParentOrders.branchId, branchId),
        eq(branchTreeParentOrders.parentKind, parent.kind),
        eq(branchTreeParentOrders.parentId, parent.id),
      ),
    );
  if (branch) return { policy: branch.orderPolicy, branchOwned: true } as const;
  const [live] =
    parent.kind === "source"
      ? await tx
          .select({ orderPolicy: contextSources.orderPolicy })
          .from(contextSources)
          .where(eq(contextSources.id, parent.sourceId))
      : await tx
          .select({ orderPolicy: folders.orderPolicy })
          .from(folders)
          .where(eq(folders.id, parent.folderId as FolderId));
  if (!live) throw new Error("Branch sibling-order parent disappeared under its namespace lock");
  return { policy: live.orderPolicy, branchOwned: false } as const;
}

async function siblings(db: Database, branchId: BranchId, parent: Parent): Promise<Sibling[]> {
  const tx = currentDrizzleDb(db);
  const view = { kind: "branch" as const, branchId };
  const vd = visibleDocuments(view);
  const vf = visibleFolders(view);
  const [documentRows, folderRows, overrides] = await Promise.all([
    tx
      .select({ id: vd.id, name: vd.name, extension: vd.extension, rank: vd.rank })
      .from(vd)
      .where(
        and(
          eq(vd.contextSourceId, parent.sourceId),
          parent.folderId === null ? isNull(vd.folderId) : eq(vd.folderId, parent.folderId),
        ),
      ),
    tx
      .select({ id: vf.id, name: vf.name, rank: vf.rank })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, parent.sourceId),
          parent.folderId === null ? isNull(vf.parentId) : eq(vf.parentId, parent.folderId),
        ),
      ),
    tx
      .select({ nodeId: branchTreeRanks.nodeId, rank: branchTreeRanks.rank })
      .from(branchTreeRanks)
      .where(
        and(
          eq(branchTreeRanks.branchId, branchId),
          eq(branchTreeRanks.parentKind, parent.kind),
          eq(branchTreeRanks.parentId, parent.id),
        ),
      ),
  ]);
  const rankById = new Map(overrides.map((row) => [row.nodeId, row.rank]));
  return [
    ...folderRows.map((row) => ({
      kind: "folder" as const,
      ...row,
      rank: rankById.get(row.id) ?? row.rank,
    })),
    ...documentRows.map((row) => ({
      kind: "document" as const,
      id: row.id,
      name: row.extension ? `${row.name}.${row.extension}` : row.name,
      rank: rankById.get(row.id) ?? row.rank,
    })),
  ];
}

async function setRank(
  db: Database,
  branchId: BranchId,
  parent: Parent,
  row: Pick<Sibling, "kind" | "id">,
  rank: string,
) {
  await currentDrizzleDb(db)
    .insert(branchTreeRanks)
    .values({
      branchId,
      parentKind: parent.kind,
      parentId: parent.id,
      nodeKind: row.kind,
      nodeId: row.id,
      rank,
    })
    .onConflictDoUpdate({
      target: [branchTreeRanks.branchId, branchTreeRanks.nodeKind, branchTreeRanks.nodeId],
      set: {
        parentKind: parent.kind,
        parentId: parent.id,
        rank,
        updatedAt: new Date(),
      },
    });
}

async function ownParent(db: Database, branchId: BranchId, parent: Parent) {
  await currentDrizzleDb(db)
    .insert(branchTreeParentOrders)
    .values({
      branchId,
      parentKind: parent.kind,
      parentId: parent.id,
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
}

async function materializeOrder(
  db: Database,
  branchId: BranchId,
  parent: Parent,
  rows: Sibling[],
  order: "default" | "effective",
): Promise<Sibling[]> {
  const ordered = [...rows].sort((left, right) => {
    if (order === "default")
      return compareDefaultSiblings(
        { kind: left.kind === "folder" ? "folder" : "file", name: left.name, identity: left.id },
        {
          kind: right.kind === "folder" ? "folder" : "file",
          name: right.name,
          identity: right.id,
        },
      );
    if (left.rank !== right.rank) return (left.rank ?? "") < (right.rank ?? "") ? -1 : 1;
    return left.id < right.id ? -1 : 1;
  });
  const ranks = generateNKeysBetween(null, null, ordered.length);
  for (const [index, row] of ordered.entries()) {
    row.rank = ranks[index] as string;
    await setRank(db, branchId, parent, row, row.rank);
  }
  await ownParent(db, branchId, parent);
  return ordered;
}

/** Allocate a drafted reorder or arrival without requiring the incoming placement to exist yet. */
export async function placeBranchSibling(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    name: string;
    position?: ContextSiblingPosition;
    arrived: boolean;
  },
): Promise<string | null | "stale-anchor"> {
  const parent = parentOf(input.sourceId, input.parentId);
  let policy = await parentPolicy(db, input.branchId, parent);
  if (!input.position && !input.arrived) {
    const [override] = await currentDrizzleDb(db)
      .select({ rank: branchTreeRanks.rank })
      .from(branchTreeRanks)
      .where(
        and(
          eq(branchTreeRanks.branchId, input.branchId),
          eq(branchTreeRanks.nodeKind, "document"),
          eq(branchTreeRanks.nodeId, input.documentId),
        ),
      );
    if (override) return override.rank;
    const [live] = await currentDrizzleDb(db)
      .select({ rank: documents.rank })
      .from(documents)
      .where(eq(documents.id, input.documentId));
    return live?.rank ?? null;
  }
  if (policy.policy === "default" && !input.position) return null;

  let rows = await siblings(db, input.branchId, parent);
  let moving = rows.find((row) => row.id === input.documentId);
  if (!moving) {
    moving = { kind: "document", id: input.documentId, name: input.name, rank: null };
    rows.push(moving);
  } else {
    moving.name = input.name;
  }
  if (input.position && policy.policy === "default") {
    rows = await materializeOrder(db, input.branchId, parent, rows, "default");
    moving = rows.find((row) => row.id === input.documentId) as Sibling;
    policy = { policy: "manual", branchOwned: true };
  }
  if (policy.policy !== "manual") return null;

  let others = rows
    .filter((row) => row.id !== input.documentId)
    .sort((left, right) => {
      if (left.rank !== right.rank) return (left.rank as string) < (right.rank as string) ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    });
  let index = others.length;
  if (input.position?.kind === "start") index = 0;
  else if (input.position && "siblingId" in input.position) {
    const position = input.position;
    const anchor = others.findIndex((row) => row.id === position.siblingId);
    if (anchor < 0) return "stale-anchor";
    index = position.kind === "before" ? anchor : anchor + 1;
  }
  if (others[index - 1]?.rank != null && others[index - 1]?.rank === others[index]?.rank) {
    rows = await materializeOrder(db, input.branchId, parent, rows, "effective");
    moving = rows.find((row) => row.id === input.documentId) as Sibling;
    others = rows.filter((row) => row.id !== input.documentId);
    if (input.position?.kind === "start") index = 0;
    else if (input.position && "siblingId" in input.position) {
      const position = input.position;
      const anchor = others.findIndex((row) => row.id === position.siblingId);
      if (anchor < 0) return "stale-anchor";
      index = position.kind === "before" ? anchor : anchor + 1;
    } else index = others.length;
  }
  const rank = generateKeyBetween(others[index - 1]?.rank ?? null, others[index]?.rank ?? null);
  await setRank(db, input.branchId, parent, moving, rank);
  return rank;
}

/** Nearest branch-relative neighbours, used to re-mint a live rank at Apply. */
export async function branchSiblingIntent(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    sourceId: ContextSourceId;
    parentId: FolderId | null;
  },
): Promise<{ left: string[]; right: string[] }> {
  const rows = (await siblings(db, input.branchId, parentOf(input.sourceId, input.parentId))).sort(
    (left, right) => {
      if (left.rank !== right.rank) return (left.rank ?? "") < (right.rank ?? "") ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    },
  );
  const index = rows.findIndex((row) => row.id === input.documentId);
  if (index < 0) return { left: [], right: [] };
  return {
    left: rows
      .slice(0, index)
      .reverse()
      .map((row) => row.id),
    right: rows.slice(index + 1).map((row) => row.id),
  };
}

/** Keep a document's rank overlay aligned with its current branch facts. */
export async function syncBranchSiblingFacts(
  db: Database,
  input: { branchId: BranchId; documentId: DocumentId; facts: BranchTreeFacts },
): Promise<void> {
  const moved = input.facts.moved;
  if (moved?.rank != null) {
    const sourceId = moved.rootSourceId as ContextSourceId | null;
    const folderId = moved.folderId as FolderId | null;
    const resolvedSource = folderId
      ? (
          await currentDrizzleDb(db)
            .select({ sourceId: folders.contextSourceId })
            .from(folders)
            .where(eq(folders.id, folderId))
        )[0]?.sourceId
      : sourceId;
    if (resolvedSource)
      await setRank(
        db,
        input.branchId,
        parentOf(resolvedSource, folderId),
        { kind: "document", id: input.documentId },
        moved.rank,
      );
  } else {
    await currentDrizzleDb(db)
      .delete(branchTreeRanks)
      .where(
        and(
          eq(branchTreeRanks.branchId, input.branchId),
          eq(branchTreeRanks.nodeKind, "document"),
          eq(branchTreeRanks.nodeId, input.documentId),
        ),
      );
  }
  await reconcileBranchSiblingOrder(db, input.branchId);
}

/** Drop promoted baselines once no outstanding ordered placement is owned by their parent. */
export async function reconcileBranchSiblingOrder(db: Database, branchId: BranchId): Promise<void> {
  const tx = currentDrizzleDb(db);
  const [owners, changes] = await Promise.all([
    tx
      .select({ kind: branchTreeParentOrders.parentKind, id: branchTreeParentOrders.parentId })
      .from(branchTreeParentOrders)
      .where(eq(branchTreeParentOrders.branchId, branchId)),
    tx
      .select({
        folderId: branchTreeChanges.movedFolderId,
        sourceId: branchTreeChanges.movedRootSourceId,
      })
      .from(branchTreeChanges)
      .where(
        and(
          eq(branchTreeChanges.branchId, branchId),
          eq(branchTreeChanges.moved, true),
          isNotNull(branchTreeChanges.movedRank),
        ),
      ),
  ]);
  const active = new Set(
    changes.map((change) =>
      change.folderId ? `folder:${change.folderId}` : `source:${change.sourceId}`,
    ),
  );
  for (const owner of owners) {
    if (active.has(`${owner.kind}:${owner.id}`)) continue;
    const owned = and(
      eq(branchTreeRanks.branchId, branchId),
      eq(branchTreeRanks.parentKind, owner.kind),
      eq(branchTreeRanks.parentId, owner.id),
    );
    await tx.delete(branchTreeRanks).where(owned);
    await tx
      .delete(branchTreeParentOrders)
      .where(
        and(
          eq(branchTreeParentOrders.branchId, branchId),
          eq(branchTreeParentOrders.parentKind, owner.kind),
          eq(branchTreeParentOrders.parentId, owner.id),
        ),
      );
  }
}
