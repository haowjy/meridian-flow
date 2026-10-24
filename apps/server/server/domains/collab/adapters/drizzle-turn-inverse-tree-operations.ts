/** Tree mutations used by the durable turn-inverse transaction orchestrator. */
import {
  type BranchTreeTransition,
  type ContextSourceId,
  type DocumentId,
  type FolderId,
  isLiveTransition,
  type LiveTreeState,
  type LiveTreeTransition,
  type TreePlacement,
  type TreeTransition,
  type UserId,
} from "@meridian/contracts";
import { branches, type Database } from "@meridian/database";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import { writeBackBranchFacts } from "../../context/tree/branch-tree-changes.js";
import { resolveAbsorbedFolders } from "../../context/tree/folder-normalization.js";
import {
  moveToPlacement,
  placementSources,
  readLiveTreeStates,
} from "../../context/tree/live-tree-state.js";
import { restoreDocument } from "../../context/tree/removal.js";
import { createTreeReader } from "../../context/tree/tree-view.js";
import { loadFolderIdentityRows } from "../../context/tree/tree-view-sql.js";
import {
  type PlannedTreeInverse,
  sameLiveState,
  type TreeInverseFault,
} from "../domain/tree-inverse.js";
import type { TurnInverseQuery } from "../domain/turn-inverse-service.js";

export type TreeOperationEntry = {
  documentId: DocumentId;
  made: Map<number, LiveTreeState>;
  living: boolean;
};

export type CommittedTreeOperation = {
  transition: TreeTransition;
};

export class TreeFault extends Error {
  constructor(readonly fault: TreeInverseFault) {
    super(`Tree inverse refused: ${fault}`);
  }
}

export function createTurnInverseTreeOperations(input: {
  db: Database;
  removal: DocumentRemoval;
  arrivals?: Pick<DocumentArrivals, "settle">;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
}) {
  const db = () => currentDrizzleDb(input.db);

  async function address(
    documentId: DocumentId,
    transition: TreeTransition,
  ): Promise<string | null> {
    const view = isLiveTransition(transition)
      ? ({ kind: "live" } as const)
      : ({ kind: "branch", branchId: transition.destination.branchId } as const);
    const status = (await createTreeReader(input.db).identityStatus(view, [documentId])).get(
      documentId,
    );
    return status?.kind === "visible" ? status.address.uri : null;
  }

  async function commit(
    entry: TreeOperationEntry,
    planned: PlannedTreeInverse,
    userId: UserId | undefined,
    query: TurnInverseQuery,
    deferredDocumentIds?: ReadonlySet<DocumentId>,
  ): Promise<CommittedTreeOperation> {
    return isLiveTransition(planned)
      ? { transition: await commitLive(entry, planned, userId, query) }
      : commitBranch(entry, planned, query, deferredDocumentIds);
  }

  async function commitLive(
    entry: TreeOperationEntry,
    planned: Extract<PlannedTreeInverse, { destination: { kind: "live" } }>,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<LiveTreeTransition> {
    const { documentId } = entry;
    const expected =
      "madeBy" in planned.before ? entry.made.get(planned.before.madeBy) : planned.before;
    const [before] = (await readLiveTreeStates(db(), [documentId])).values();
    if (!expected || !sameLiveState(before, expected)) throw new TreeFault("superseded");
    const fault = await applyLive(
      documentId,
      planned.op,
      { before: expected, after: planned.after },
      userId,
      query,
    );
    if (fault) throw new TreeFault(fault);
    const [after] = (await readLiveTreeStates(db(), [documentId])).values();
    if (!after) throw new Error(`Tree inverse left ${documentId} hidden`);
    entry.made.set(planned.step, after);
    entry.living = after.living;
    return { destination: planned.destination, before: expected, after };
  }

  async function commitBranch(
    entry: TreeOperationEntry,
    planned: BranchTreeTransition & PlannedTreeInverse,
    query: TurnInverseQuery,
    deferredDocumentIds?: ReadonlySet<DocumentId>,
  ): Promise<CommittedTreeOperation> {
    const { branchId } = planned.destination;
    const [branch] = await db()
      .select({ status: branches.status })
      .from(branches)
      .where(eq(branches.id, branchId));
    if (branch?.status !== "active") throw new TreeFault("refused");
    if (planned.entry.tree.op === "create") {
      if (planned.op !== "create" && planned.op !== "delete")
        throw new Error("A drafted create can only be removed or restored");
    }
    const committed = await writeBackBranchFacts(input.db, {
      branchId,
      documentId: entry.documentId,
      expected: planned.before,
      facts: planned.after,
      changedBy: { threadId: query.threadId, ...(query.turnId ? { turnId: query.turnId } : {}) },
      deferredDocumentIds,
    });
    if (!committed.ok) throw new TreeFault(committed.error);
    return {
      transition: {
        destination: planned.destination,
        before: planned.before,
        after: committed.value,
      },
    };
  }

  async function applyLive(
    documentId: DocumentId,
    op: PlannedTreeInverse["op"],
    { before, after }: Pick<LiveTreeTransition, "before" | "after">,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<TreeInverseFault | null> {
    const deps = { arrivals: input.arrivals, catalog: input.catalog };
    switch (op) {
      case "create": {
        if (!before || before.living) throw new Error("A create inverse starts from a removal");
        if (!after.living) throw new Error("A create inverse ends at a placement");
        const at = await restoreTarget(after.at);
        if (!at) return "folder_missing";
        const restored = await restoreDocument(
          input.db,
          {
            documentId,
            removal: {
              time: new Date(before.removal.time),
              locationVersion: BigInt(before.removal.locationVersion),
            },
            at,
            created: true,
          },
          deps,
        );
        if (restored.kind !== "restored")
          return restored.kind === "already_living" ? "superseded" : "refused";
        return null;
      }
      case "move": {
        if (!before?.living || !after.living)
          throw new Error("A move inverse joins two placements");
        const moved = await moveToPlacement(
          input.db,
          { documentId, from: before.at, to: after.at },
          deps,
        );
        return moved.kind === "moved"
          ? null
          : moved.kind === "ancestor_taken"
            ? "ancestor_taken"
            : moved.kind;
      }
      case "restore": {
        if (!before || before.living) throw new Error("A restore inverse starts from a removal");
        if (!after.living) throw new Error("A restore inverse ends at a placement");
        const at = await restoreTarget(after.at);
        if (!at) return "folder_missing";
        const restored = await restoreDocument(
          input.db,
          {
            documentId,
            removal: {
              time: new Date(before.removal.time),
              locationVersion: BigInt(before.removal.locationVersion),
            },
            at,
          },
          deps,
        );
        if (restored.kind === "restored") return null;
        return restored.kind === "already_living"
          ? "superseded"
          : restored.kind === "ancestor_taken"
            ? "ancestor_taken"
            : restored.kind;
      }
      case "delete": {
        if (!before?.living) throw new Error("A delete inverse starts from a placement");
        await input.removal.remove({
          documentIds: [documentId],
          reason: "deleted",
          ...(userId ? { userId } : { threadId: query.threadId }),
        });
        const [source] = await placementSources(input.db, [before.at]);
        await input.catalog.refreshSources(source ? [source] : [], [documentId]);
        return null;
      }
    }
  }

  async function restoreTarget(at: TreePlacement) {
    if (!at.folderId)
      return at.rootSourceId
        ? {
            contextSourceId: at.rootSourceId as ContextSourceId,
            parentFolderId: null,
            name: at.name,
            extension: at.extension,
          }
        : null;
    const requested = at.folderId as FolderId;
    const folderId =
      (await resolveAbsorbedFolders(input.db, [requested])).get(requested) ?? requested;
    const [folder] = await loadFolderIdentityRows(db(), [folderId]);
    return folder && !folder.deleted
      ? {
          contextSourceId: folder.contextSourceId,
          parentFolderId: folderId,
          name: at.name,
          extension: at.extension,
        }
      : null;
  }

  return { address, commit };
}
