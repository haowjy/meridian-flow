/**
 * Tree half of Apply: the drafted records of the click's items become live copies in the lists
 * that hold them (`applyDraft`), in the click's transaction, and the command keeps what Un-Apply
 * needs of each list (`apply_command_trees`). It reports which items landed, read from the lists
 * under their keys; the caller (`drizzle-apply-click.ts`) decides every answer and the text half.
 *
 * Lock order, as `collab/.context/CONTEXT.md` has it: the caller holds the Work and the draft;
 * the lists' keys come next (`lockItems`), then the documents', and only then the writes.
 */

import type { CommandId, DocumentId, DraftId, UserId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { applyCommandTrees } from "@meridian/database/schema";
import {
  applyDraft,
  LIVE,
  pendingRecords,
  recordsOfItem,
  type TreeRecord,
} from "@meridian/project-tree";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeJudge } from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { ListWriter, TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { TreeCut } from "../domain/press.js";
import { treeListOfNode } from "./drizzle-draft-tree-lists.js";

export type TreeApplyItem = {
  node: string;
  list: TreeList | null;
  tree: boolean;
};

const sameList = (a: TreeList, b: TreeList) =>
  a.kind === b.kind &&
  (a.kind === "project"
    ? a.projectId === (b as typeof a).projectId
    : a.userId === (b as typeof a).userId);

export function createApplyTreeOperations(input: {
  db: Database;
  treeLists: Pick<TreeListStore, "lock" | "submit">;
  arrivals?: Pick<DocumentArrivals, "settle">;
  onCommitted(documentId: DocumentId): Promise<void>;
}) {
  /**
   * The lists that hold the nodes, their keys, then the nodes' document keys in id order: every
   * read that decides a write comes after this.
   */
  async function lockItems(nodes: readonly string[]): Promise<Map<string, TreeList | null>> {
    const listOf = new Map<string, TreeList | null>();
    const lists: TreeList[] = [];
    for (const node of nodes) {
      const found = await treeListOfNode(input.db, node);
      const list = found && (lists.find((other) => sameList(other, found)) ?? found);
      if (list && !lists.includes(list)) lists.push(list);
      listOf.set(node, list);
    }
    if (lists.length) await input.treeLists.lock(lists);
    const tx = currentDrizzleDb(input.db);
    for (const node of [...nodes].sort()) await lockDocumentMutation(tx, node as DocumentId);
    return listOf;
  }

  async function apply(click: {
    draftId: DraftId;
    userId: UserId;
    commandId: CommandId;
    treeCommand: string;
    saw: TreeCut | undefined;
    items: readonly TreeApplyItem[];
    judge: TreeJudge;
  }): Promise<Set<string>> {
    const { draftId, items } = click;
    const lists: TreeList[] = [];
    for (const { list } of items) if (list && !lists.includes(list)) lists.push(list);
    const landed = new Set<string>();
    if (lists.length === 0) return landed;
    const documents = new Set<DocumentId>();
    const actor = `user:${click.userId}`;

    const { result: perList } = await input.treeLists.submit({
      lists,
      make: (writers) => {
        const rows: { scope: "project" | "account" }[] = [];
        for (const [at, end] of writers.entries()) {
          const { writer } = end;
          const list = lists[at] as TreeList;
          const saw = cutOf(click.saw, list.kind, end);
          const pending = pendingRecords(writer.doc, draftId);
          const draft = writer.view({ draft: draftId });
          const mine = items.filter((it) => it.list === list);
          const recordsOf = new Map<string, TreeRecord[]>();
          for (const it of mine) {
            if (
              (draft.nodes.get(it.node) ?? writer.view(LIVE).nodes.get(it.node))?.kind !== "folder"
            )
              documents.add(it.node as DocumentId);
            const ran =
              it.tree ||
              pending.some((record) => record.type === "create" && record.node === it.node);
            recordsOf.set(it.node, ran ? recordsOfItem(draft, pending, it.node) : []);
          }
          const chosen = [...recordsOf.values()].flat();
          const applied = chosen.length
            ? applyDraft(
                writer,
                draftId,
                actor,
                click.treeCommand,
                [...new Set(chosen.map((record) => record.id))],
                saw,
                click.judge.closed,
              )
            : null;
          const copied = new Set((applied?.copies ?? []).map((copy) => copy.carries));
          for (const it of mine)
            if (
              (recordsOf.get(it.node) ?? []).some((record) =>
                copied.has(record.carries ?? record.id),
              )
            )
              landed.add(it.node);
          if (applied) rows.push({ scope: list.kind });
        }
        click.judge.assertLocked();
        return rows;
      },
    });

    const tx = currentDrizzleDb(input.db);
    if (perList.length > 0)
      await tx.insert(applyCommandTrees).values(
        perList.map((row) => ({
          commandId: click.commandId,
          draftId,
          scope: row.scope,
        })),
      );
    if (perList.length > 0) {
      await input.arrivals?.settle([...documents]);
      for (const documentId of documents)
        runAfterDrizzleCommit(() => input.onCommitted(documentId));
    }
    return landed;
  }

  return { lockItems, apply };
}

function cutOf(cut: TreeCut | undefined, scope: TreeList["kind"], end: ListWriter) {
  const one = cut?.[scope];
  return one && one.list === end.list ? one.vector : undefined;
}
