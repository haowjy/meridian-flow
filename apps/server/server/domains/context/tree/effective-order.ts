/**
 * The one read boundary for a tree view's sibling order: a parent's order policy and the rank of
 * each child, as the view sees them. A branch's own overrides win over the live tree's values;
 * allocation and settlement (`branch-sibling-order.ts`) and the filesystem listing
 * (`drizzle-store.ts`) both compose them here.
 */
import type { BranchId, ContextSourceId, FolderId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branchTreeParentOrders, branchTreeRanks } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { liveParentOrderPolicy } from "./sibling-order.js";

/** A source's top level or a folder: whatever holds an ordered list of children. */
export type SiblingParent = {
  kind: "source" | "folder";
  id: ContextSourceId | FolderId;
  sourceId: ContextSourceId;
  folderId: FolderId | null;
};

export function siblingParent(sourceId: ContextSourceId, folderId: FolderId | null): SiblingParent {
  return folderId === null
    ? { kind: "source", id: sourceId, sourceId, folderId }
    : { kind: "folder", id: folderId, sourceId, folderId };
}

/** The parent's policy for a branch (its own override, else the live value) or the live tree. */
export async function effectiveParentPolicy(
  db: Database,
  branchId: BranchId | null,
  parent: SiblingParent,
) {
  if (branchId !== null) {
    const [override] = await currentDrizzleDb(db)
      .select({ orderPolicy: branchTreeParentOrders.orderPolicy })
      .from(branchTreeParentOrders)
      .where(
        and(
          eq(branchTreeParentOrders.branchId, branchId),
          eq(branchTreeParentOrders.parentKind, parent.kind),
          eq(branchTreeParentOrders.parentId, parent.id),
        ),
      );
    if (override) return { policy: override.orderPolicy, branchOwned: true } as const;
  }
  return {
    policy: await liveParentOrderPolicy(db, parent.sourceId, parent.folderId),
    branchOwned: false,
  } as const;
}

/** The branch's rank for each child of `parent` that it owns; the live rank applies to the rest. */
export async function branchRankOverrides(
  db: Database,
  branchId: BranchId,
  parent: SiblingParent,
): Promise<Map<string, string | null>> {
  const rows = await currentDrizzleDb(db)
    .select({ nodeId: branchTreeRanks.nodeId, rank: branchTreeRanks.rank })
    .from(branchTreeRanks)
    .where(
      and(
        eq(branchTreeRanks.branchId, branchId),
        eq(branchTreeRanks.parentKind, parent.kind),
        eq(branchTreeRanks.parentId, parent.id),
      ),
    );
  return new Map(rows.map((row) => [row.nodeId, row.rank]));
}
