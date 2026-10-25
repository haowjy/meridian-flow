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
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
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

type RankedNode = { id: string; rank: string };

function nearest(rows: RankedNode[], direction: "before" | "after"): RankedNode | null {
  return (
    rows.sort((left, right) => {
      const compared =
        left.rank === right.rank
          ? left.id.localeCompare(right.id)
          : left.rank.localeCompare(right.rank);
      return direction === "before" ? -compared : compared;
    })[0] ?? null
  );
}

async function branchRankedNode(
  db: Database,
  branchId: BranchId,
  parent: Parent,
  branchOwned: boolean,
  id: string,
): Promise<RankedNode | null> {
  const tx = currentDrizzleDb(db);
  if (branchOwned) {
    const [row] = await tx
      .select({ id: branchTreeRanks.nodeId, rank: branchTreeRanks.rank })
      .from(branchTreeRanks)
      .where(
        and(
          eq(branchTreeRanks.branchId, branchId),
          eq(branchTreeRanks.parentKind, parent.kind),
          eq(branchTreeRanks.parentId, parent.id),
          eq(branchTreeRanks.nodeId, id),
        ),
      );
    return row ?? null;
  }
  const view = { kind: "branch" as const, branchId };
  const vd = visibleDocuments(view);
  const vf = visibleFolders(view);
  const [documentRows, folderRows] = await Promise.all([
    tx
      .select({ id: vd.id, rank: vd.rank })
      .from(vd)
      .where(
        and(
          eq(vd.id, id as DocumentId),
          eq(vd.contextSourceId, parent.sourceId),
          parent.folderId === null ? isNull(vd.folderId) : eq(vd.folderId, parent.folderId),
          isNotNull(vd.rank),
        ),
      ),
    tx
      .select({ id: vf.id, rank: vf.rank })
      .from(vf)
      .where(
        and(
          eq(vf.id, id as FolderId),
          eq(vf.contextSourceId, parent.sourceId),
          parent.folderId === null ? isNull(vf.parentId) : eq(vf.parentId, parent.folderId),
          isNotNull(vf.rank),
        ),
      ),
  ]);
  const row = documentRows[0] ?? folderRows[0];
  return row?.rank ? { id: row.id, rank: row.rank } : null;
}

async function branchRankBoundary(
  db: Database,
  input: {
    branchId: BranchId;
    parent: Parent;
    branchOwned: boolean;
    movingId: string;
    direction: "before" | "after";
    anchor?: RankedNode;
  },
): Promise<RankedNode | null> {
  const tx = currentDrizzleDb(db);
  const rankOrder = input.direction === "before" ? desc : asc;
  const relation = (rank: Parameters<typeof eq>[0], id: Parameters<typeof eq>[0]) =>
    input.anchor
      ? input.direction === "before"
        ? sql`(${rank} COLLATE "C" < ${input.anchor.rank} OR (${rank} = ${input.anchor.rank} AND ${id} < ${input.anchor.id}::uuid))`
        : sql`(${rank} COLLATE "C" > ${input.anchor.rank} OR (${rank} = ${input.anchor.rank} AND ${id} > ${input.anchor.id}::uuid))`
      : undefined;
  const order = (rank: Parameters<typeof eq>[0], id: Parameters<typeof eq>[0]) => [
    rankOrder(sql`${rank} COLLATE "C"`),
    rankOrder(id),
  ];
  if (input.branchOwned) {
    const [row] = await tx
      .select({ id: branchTreeRanks.nodeId, rank: branchTreeRanks.rank })
      .from(branchTreeRanks)
      .where(
        and(
          eq(branchTreeRanks.branchId, input.branchId),
          eq(branchTreeRanks.parentKind, input.parent.kind),
          eq(branchTreeRanks.parentId, input.parent.id),
          ne(branchTreeRanks.nodeId, input.movingId),
          relation(branchTreeRanks.rank, branchTreeRanks.nodeId),
        ),
      )
      .orderBy(...order(branchTreeRanks.rank, branchTreeRanks.nodeId))
      .limit(1);
    return row ?? null;
  }
  const view = { kind: "branch" as const, branchId: input.branchId };
  const vd = visibleDocuments(view);
  const vf = visibleFolders(view);
  const [documentRows, folderRows] = await Promise.all([
    tx
      .select({ id: vd.id, rank: vd.rank })
      .from(vd)
      .where(
        and(
          eq(vd.contextSourceId, input.parent.sourceId),
          input.parent.folderId === null
            ? isNull(vd.folderId)
            : eq(vd.folderId, input.parent.folderId),
          ne(vd.id, input.movingId as DocumentId),
          isNotNull(vd.rank),
          relation(vd.rank, vd.id),
        ),
      )
      .orderBy(...order(vd.rank, vd.id))
      .limit(1),
    tx
      .select({ id: vf.id, rank: vf.rank })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, input.parent.sourceId),
          input.parent.folderId === null
            ? isNull(vf.parentId)
            : eq(vf.parentId, input.parent.folderId),
          ne(vf.id, input.movingId as FolderId),
          isNotNull(vf.rank),
          relation(vf.rank, vf.id),
        ),
      )
      .orderBy(...order(vf.rank, vf.id))
      .limit(1),
  ]);
  return nearest(
    [...documentRows, ...folderRows].flatMap((row) =>
      row.rank ? [{ id: row.id, rank: row.rank }] : [],
    ),
    input.direction,
  );
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

  let rows: Sibling[] | null = null;
  let moving: Sibling = {
    kind: "document",
    id: input.documentId,
    name: input.name,
    rank: null,
  };
  if (input.position && policy.policy === "default") {
    rows = await siblings(db, input.branchId, parent);
    const existing = rows.find((row) => row.id === input.documentId);
    if (existing) moving = Object.assign(existing, { name: input.name });
    else rows.push(moving);
    rows = await materializeOrder(db, input.branchId, parent, rows, "default");
    moving = rows.find((row) => row.id === input.documentId) as Sibling;
    policy = { policy: "manual", branchOwned: true };
  }
  if (policy.policy !== "manual") return null;

  let before: string | null = null;
  let after: string | null = null;
  if (!input.position || input.position.kind === "end")
    before =
      (
        await branchRankBoundary(db, {
          branchId: input.branchId,
          parent,
          branchOwned: policy.branchOwned,
          movingId: input.documentId,
          direction: "before",
        })
      )?.rank ?? null;
  else if (input.position.kind === "start")
    after =
      (
        await branchRankBoundary(db, {
          branchId: input.branchId,
          parent,
          branchOwned: policy.branchOwned,
          movingId: input.documentId,
          direction: "after",
        })
      )?.rank ?? null;
  else {
    if (!("siblingId" in input.position)) throw new Error("Invalid sibling position");
    const anchor = await branchRankedNode(
      db,
      input.branchId,
      parent,
      policy.branchOwned,
      input.position.siblingId,
    );
    if (!anchor || anchor.id === input.documentId) return "stale-anchor";
    if (input.position.kind === "before") {
      after = anchor.rank;
      before =
        (
          await branchRankBoundary(db, {
            branchId: input.branchId,
            parent,
            branchOwned: policy.branchOwned,
            movingId: input.documentId,
            direction: "before",
            anchor,
          })
        )?.rank ?? null;
    } else {
      before = anchor.rank;
      after =
        (
          await branchRankBoundary(db, {
            branchId: input.branchId,
            parent,
            branchOwned: policy.branchOwned,
            movingId: input.documentId,
            direction: "after",
            anchor,
          })
        )?.rank ?? null;
    }
  }
  if (before !== null && before === after) {
    rows ??= await siblings(db, input.branchId, parent);
    const existing = rows.find((row) => row.id === input.documentId);
    if (existing) moving = Object.assign(existing, { name: input.name });
    else rows.push(moving);
    rows = await materializeOrder(db, input.branchId, parent, rows, "effective");
    moving = rows.find((row) => row.id === input.documentId) as Sibling;
    const others = rows.filter((row) => row.id !== input.documentId);
    let index = others.length;
    if (input.position?.kind === "start") index = 0;
    else if (input.position && "siblingId" in input.position) {
      const position = input.position;
      const anchor = others.findIndex((row) => row.id === position.siblingId);
      if (anchor < 0) return "stale-anchor";
      index = position.kind === "before" ? anchor : anchor + 1;
    }
    before = others[index - 1]?.rank ?? null;
    after = others[index]?.rank ?? null;
  }
  const rank = generateKeyBetween(before, after);
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
