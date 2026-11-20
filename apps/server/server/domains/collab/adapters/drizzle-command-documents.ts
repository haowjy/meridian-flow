/**
 * The documents a command touched, from its own record: what a route must hold edit grants on
 * before Un-Apply or Undo of a Discard writes them. A folder has no document and no grant.
 * `redoItems` reads the same records for a Redo: what an Un-Apply took back.
 */
import type { BranchId, CommandId, DocumentId, UserId } from "@meridian/contracts";
import type { ApplyItemsClick, UnapplyClickResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { applyCommandTrees, commands, documents } from "@meridian/database/schema";
import { discardedBy } from "@meridian/project-tree";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { documentsOfCommand } from "./drizzle-command-edits.js";

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
  const textOf = async (commandId: CommandId, accountId: UserId) =>
    (await documentsOfCommand(currentDrizzleDb(db), commandId, accountId)).map(
      (text) => text.documentId,
    );

  return {
    /** The documents an Apply command wrote text in or copied tree records of. */
    async ofApply(input: { applyCommandId: CommandId; accountId: UserId }): Promise<DocumentId[]> {
      const trees = await currentDrizzleDb(db)
        .select({ nodes: applyCommandTrees.nodes })
        .from(applyCommandTrees)
        .innerJoin(commands, eq(commands.id, applyCommandTrees.commandId))
        .where(
          and(
            eq(applyCommandTrees.commandId, input.applyCommandId),
            eq(commands.accountId, input.accountId),
          ),
        );
      return documentsAmong([
        ...(await textOf(input.applyCommandId, input.accountId)),
        ...trees.flatMap((row) => row.nodes),
      ]);
    },

    /**
     * What an Un-Apply took back, as the items of its Redo: the documents whose tree half it took
     * back, and those it took text from, whose text the Redo's Undo of it brings back. Empty when
     * it took nothing, or is not this account's.
     */
    async redoItems(input: {
      unapplyCommandId: CommandId;
      accountId: UserId;
    }): Promise<ApplyItemsClick["items"]> {
      const [own] = await currentDrizzleDb(db)
        .select({ outcome: commands.outcome })
        .from(commands)
        .where(
          and(
            eq(commands.id, input.unapplyCommandId),
            eq(commands.accountId, input.accountId),
            eq(commands.kind, "unapply"),
          ),
        );
      if (!own || own.outcome.status === "never") return [];
      const { treeUndone } = own.outcome.result as UnapplyClickResult;
      const items = new Map<string, ApplyItemsClick["items"][number]>();
      for (const node of treeUndone) items.set(node, { node, tree: true });
      for (const node of await textOf(input.unapplyCommandId, input.accountId))
        if (!items.has(node)) items.set(node, { node });
      return [...items.values()];
    },

    /** The documents a Discard command settled records of or took text from. */
    async ofDiscard(input: {
      discardCommandId: CommandId;
      accountId: UserId;
      branchId: BranchId;
    }): Promise<DocumentId[]> {
      const nodes = await deps.treeLists.read({
        lists: await treeListsOfBranch(db, input.branchId),
        view: (ends) =>
          ends.flatMap(({ writer }) =>
            discardedBy(writer.doc, input.discardCommandId).records.map((record) => record.node),
          ),
      });
      return documentsAmong([...(await textOf(input.discardCommandId, input.accountId)), ...nodes]);
    },
  };
}
