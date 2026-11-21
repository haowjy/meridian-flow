/**
 * Work purge's disposal of a purged Work (§2.6, F10), inside purge's transaction after its
 * deleted/cutoff proof: the draft the Work names and those its purged lineages' roots name each
 * have their tree records discarded, and their suggestions leave every document that holds them,
 * with their authors; the purge then deletes their rows. The Work and the
 * lineages it purges are gone for good, so nothing is recorded to take back. The public command's
 * active-Work fence is never used, and no pending projection runs: the Work is being deleted.
 * Its drafted creates are in no view afterwards and retention purges them.
 */
import { dropDraft, type UpdateJournal } from "@meridian/agent-edit/integration";
import type { DraftId, WorkId } from "@meridian/contracts";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { newId } from "@meridian/project-tree";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { WorkBranchDisposal } from "../../projects/index.js";
import type { Branches } from "../domain/branches.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { storedDocument } from "../domain/stored-document.js";
import { documentsHolding } from "./drizzle-block-text.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { discardTreeRecords } from "./drizzle-work-tree-discard.js";

const schema = buildDocumentSchema();

export function createDrizzleWorkBranchDisposal(
  db: Database,
  deps: {
    branches: Pick<Branches, "namedBy" | "lock">;
    treeLists: Pick<TreeListStore, "lock" | "submit" | "resync">;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    /** After commit, for each document whose text changed: its derivations (the pending index). */
    onCommitted(documentId: DocumentId): Promise<void>;
  },
): WorkBranchDisposal {
  /** The drafts' suggestions out of one document, appended as nobody's edit. Its key is held. */
  async function dropText(id: DocumentId, draftIds: readonly DraftId[]): Promise<void> {
    const snapshot = await deps.live.read(id);
    if (!snapshot.authority) return;
    const doc = storedDocument(snapshot);
    try {
      const before = Y.encodeStateVector(doc);
      let changed = false;
      for (const draft of draftIds) changed = dropDraft(doc, schema, draft) || changed;
      if (!changed) return;
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

  async function dispose(
    workId: WorkId,
    lineageRootIds: readonly string[],
  ): Promise<{ releasedObjects: readonly string[]; draftIds: readonly DraftId[] }> {
    const named = (await deps.branches.namedBy({ workId, lineageRootIds })).sort();
    const draftIds: DraftId[] = [];
    for (const draftId of named) if (await deps.branches.lock(draftId)) draftIds.push(draftId);
    // Every list in one call, after the drafts and before the documents (the press's lock
    // order): the drafts' lists, the held documents' lists, and the Work's project's list,
    // which the purge writes next.
    const [work] = await currentDrizzleDb(db)
      .select({ projectId: works.projectId, userId: works.createdByUserId })
      .from(works)
      .where(eq(works.id, workId));
    // The press's enumeration: projects have one owner, so the Work's documents are its project's
    // and its creator's account's.
    const held = work ? await documentsHolding(db, work, draftIds) : [];
    const lists = new Map<string, TreeList>();
    for (const draftId of draftIds)
      for (const list of await treeListsOfBranch(db, draftId)) lists.set(listKey(list), list);
    for (const projectId of [work?.projectId, ...held.map((row) => row.projectId)])
      if (projectId) {
        const list: TreeList = { kind: "project", projectId: projectId as ProjectId };
        lists.set(listKey(list), list);
      }
    for (const { userId } of held)
      if (userId) {
        const list: TreeList = { kind: "account", userId: userId as UserId };
        lists.set(listKey(list), list);
      }
    if (lists.size > 0) await deps.treeLists.lock([...lists.values()]);
    // One pass per draft: its tree records settled discarded in each list, then its view's rows
    // go. The purge deletes the rows after the Work and chats naming them.
    for (const branchId of draftIds) {
      await discardTreeRecords(db, deps, { branchId, commandId: newId() });
      await deps.treeLists.resync(await treeListsOfBranch(db, branchId));
    }
    const ids = [...new Set(held.map((row) => row.id as DocumentId))].sort();
    for (const id of ids) await lockDocumentMutation(currentDrizzleDb(db), id);
    for (const id of ids) await dropText(id, draftIds);
    return { releasedObjects: [], draftIds };
  }

  return {
    withDisposal(workId, run) {
      return run((roots) => dispose(workId, roots));
    },
  };
}

function listKey(list: TreeList): string {
  return list.kind === "project" ? `project:${list.projectId}` : `account:${list.userId}`;
}
