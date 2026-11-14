/**
 * The documents a command touched, from its own record: what a route must hold edit grants on
 * before Un-Apply or Undo of a Discard writes them. A folder has no document and no grant.
 */
import type { BranchId, CommandId, DocumentId, UserId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  applyCommandEffects,
  applyCommandTrees,
  commands,
  discardCommandDrafts,
  documentDrafts,
  documents,
} from "@meridian/database/schema";
import { discardedBy } from "@meridian/project-tree";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";

export function createDrizzleCommandDocuments(
  db: Database,
  deps: { treeLists: Pick<TreeListStore, "read"> },
) {
  const documentsAmong = async (ids: Iterable<string>): Promise<DocumentId[]> => {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    const rows = await currentDrizzleDb(db)
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.id, wanted as DocumentId[]));
    return rows.map((row) => row.id);
  };

  return {
    /** The documents an Apply command wrote text in or copied tree records of. */
    async ofApply(input: {
      applyCommandId: CommandId;
      accountId: UserId;
      branchId: BranchId;
    }): Promise<DocumentId[]> {
      const tx = currentDrizzleDb(db);
      const text = await tx
        .select({ id: applyCommandEffects.documentId })
        .from(applyCommandEffects)
        .innerJoin(commands, eq(commands.id, applyCommandEffects.commandId))
        .where(
          and(
            eq(applyCommandEffects.commandId, input.applyCommandId),
            eq(commands.accountId, input.accountId),
          ),
        );
      const trees = await tx
        .select({ nodes: applyCommandTrees.nodes })
        .from(applyCommandTrees)
        .innerJoin(commands, eq(commands.id, applyCommandTrees.commandId))
        .where(
          and(
            eq(applyCommandTrees.commandId, input.applyCommandId),
            eq(applyCommandTrees.branchId, input.branchId),
            eq(commands.accountId, input.accountId),
          ),
        );
      return documentsAmong([...text.map((row) => row.id), ...trees.flatMap((row) => row.nodes)]);
    },

    /** The documents a Discard command settled records of or closed text drafts on. */
    async ofDiscard(input: {
      discardCommandId: CommandId;
      accountId: UserId;
      branchId: BranchId;
    }): Promise<DocumentId[]> {
      const tx = currentDrizzleDb(db);
      const text = await tx
        .select({ id: documentDrafts.documentId })
        .from(discardCommandDrafts)
        .innerJoin(documentDrafts, eq(documentDrafts.id, discardCommandDrafts.draftId))
        .innerJoin(commands, eq(commands.id, discardCommandDrafts.commandId))
        .where(
          and(
            eq(discardCommandDrafts.commandId, input.discardCommandId),
            eq(commands.accountId, input.accountId),
            eq(documentDrafts.branchId, input.branchId),
          ),
        );
      const nodes = await deps.treeLists.read({
        lists: await treeListsOfBranch(db, input.branchId),
        view: (ends) =>
          ends.flatMap(({ writer }) =>
            discardedBy(writer.doc, input.discardCommandId).records.map((record) => record.node),
          ),
      });
      return documentsAmong([...text.map((row) => row.id), ...nodes]);
    },
  };
}
