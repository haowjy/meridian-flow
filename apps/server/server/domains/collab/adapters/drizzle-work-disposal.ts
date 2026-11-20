/**
 * Work purge's disposal of a purged Work (§2.6, F10), inside purge's transaction after its
 * deleted/cutoff proof: each of its active branches has its tree records discarded and closes, and
 * its suggestions leave every document that holds them, with their authors. The Work and the
 * lineages it purges are gone for good, so nothing is recorded to take back. The public command's
 * active-Work fence is never used, and no pending projection runs: the Work is being deleted.
 * Its drafted creates are in no view afterwards and retention purges them.
 */
import { dropWork, type UpdateJournal } from "@meridian/agent-edit/integration";
import { type DraftOwnerKey, draftOwnerKey, type WorkId } from "@meridian/contracts";
import type { DocumentId, ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBlockRooms, documents, works } from "@meridian/database/schema";
import { newId } from "@meridian/project-tree";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkBranchDisposal } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { storedDocument } from "../domain/stored-document.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";

const schema = buildDocumentSchema();

export function createDrizzleWorkBranchDisposal(
  db: Database,
  deps: {
    branches: Pick<Branches, "byOriginWork" | "activeByOriginLineages" | "lockActive" | "close">;
    treeLists: Pick<TreeListStore, "lock" | "submit" | "resync">;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    /** After commit, for each document whose text changed: its derivations (the pending index). */
    onCommitted(documentId: DocumentId): Promise<void>;
  },
): WorkBranchDisposal {
  /** One branch: every pending tree record settled discarded in each list, then the row closes. */
  async function disposeBranch(branchId: Parameters<Branches["close"]>[0]): Promise<void> {
    await discardTreeRecords(db, deps, { branchId, commandId: newId() });
    await deps.branches.close(branchId, new Date());
    // The branch ended and its drafts closed: the rows of its view go.
    await deps.treeLists.resync(await treeListsOfBranch(db, branchId));
  }

  /**
   * The owners' suggestions out of every document the pending index lists for them. The index
   * lags a document's derivation by seconds, and an owner purged 30 days after its delete writes
   * nothing in that time.
   */
  async function dropText(workId: WorkId, owners: readonly DraftOwnerKey[]): Promise<void> {
    const tx = currentDrizzleDb(db);
    const held = await tx
      .select({ id: documents.id, projectId: documents.projectId, userId: documents.userId })
      .from(documentBlockRooms)
      .innerJoin(documents, eq(documents.id, documentBlockRooms.documentId))
      .where(
        sql`${documentBlockRooms.pendingChanges} ?| array[${sql.join(
          owners.map((owner) => sql`${owner}`),
          sql`, `,
        )}]::text[]`,
      );
    if (held.length === 0) return;
    const [work] = await tx
      .select({ projectId: works.projectId })
      .from(works)
      .where(eq(works.id, workId));
    // The lists before the documents (the press's lock order): purge writes the project's list next.
    const lists = new Map<string, TreeList>();
    for (const projectId of [work?.projectId, ...held.map((row) => row.projectId)])
      if (projectId)
        lists.set(`p:${projectId}`, { kind: "project", projectId: projectId as ProjectId });
    for (const { userId } of held)
      if (userId) lists.set(`u:${userId}`, { kind: "account", userId: userId as UserId });
    await deps.treeLists.lock([...lists.values()]);
    const ids = [...new Set(held.map((row) => row.id as DocumentId))].sort();
    for (const id of ids) await lockDocumentMutation(tx, id);
    for (const id of ids) {
      const snapshot = await deps.live.read(id);
      if (!snapshot.authority) continue;
      const doc = storedDocument(snapshot);
      try {
        const before = Y.encodeStateVector(doc);
        let changed = false;
        for (const owner of owners) changed = dropWork(doc, schema, owner) || changed;
        if (!changed) continue;
        await deps.live.append(
          id,
          Y.encodeStateAsUpdate(doc, before),
          { seq: 0, origin: "system" },
          snapshot.authority,
        );
        deferUntilDrizzleCommit(async () => {
          await deps.liveCoordinator.deliver(id);
          await deps.onCommitted(id);
        });
      } finally {
        doc.destroy();
      }
    }
  }

  async function dispose(
    workId: WorkId,
    lineageRootIds: readonly string[],
  ): Promise<{ releasedObjects: readonly string[] }> {
    const owned = [
      ...(await deps.branches.byOriginWork(workId)),
      ...(await deps.branches.activeByOriginLineages(lineageRootIds as ThreadId[])),
    ];
    for (const branchId of owned.map((branch) => branch.id).sort())
      if (await deps.branches.lockActive(branchId)) await disposeBranch(branchId);
    await dropText(workId, [
      draftOwnerKey({ kind: "work", workId }),
      ...lineageRootIds.map((rootThreadId) => draftOwnerKey({ kind: "lineage", rootThreadId })),
    ]);
    return { releasedObjects: [] };
  }

  return {
    withDisposal(workId, run) {
      return run((roots) => dispose(workId, roots));
    },
  };
}
