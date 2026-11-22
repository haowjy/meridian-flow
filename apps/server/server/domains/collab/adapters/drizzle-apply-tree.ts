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
import { encodedVersionOf } from "@meridian/document-model";
import {
  applyDraft,
  covers,
  LIVE,
  pendingRecords,
  recordsOfItem,
  type TreeRecord,
} from "@meridian/project-tree";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { TreeJudge } from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { ListWriter, TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import { PressUnsynced, type TreeCut } from "../domain/press.js";
import { treeListOfNode } from "./drizzle-draft-tree-lists.js";

/** One item of an Apply as the tree half reads it. */
export type TreeApplyItem = {
  node: string;
  /** The list that holds the node; null when none does (purged). */
  list: TreeList | null;
  /** The click includes the node's tree records. */
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

  /**
   * Lands what the Work has pending on each item whose tree half runs: its own records, the
   * delete that covers it, the drafted creates they stand on and the earlier records of the same
   * facts, as one `applyDraft` per list, limited to `saw`. Returns the items one of whose
   * chosen records landed as a live copy.
   */
  async function apply(click: {
    draftId: DraftId;
    userId: UserId;
    commandId: CommandId;
    saw: TreeCut | undefined;
    items: readonly TreeApplyItem[];
    /** Under the owners' locks: what each source takes. */
    judge: TreeJudge;
  }): Promise<Set<string>> {
    const { draftId, items } = click;
    const lists: TreeList[] = [];
    for (const { list } of items) if (list && !lists.includes(list)) lists.push(list);
    const landed = new Set<string>();
    if (lists.length === 0) return landed;
    // The documents among the items, as the Work's view or live has them.
    const documents = new Set<DocumentId>();
    const actor = `user:${click.userId}`;

    const { result: perList } = await input.treeLists.submit({
      lists,
      make: (writers) => {
        const rows: {
          scope: "project" | "account";
          mark: Uint8Array;
          created: string[];
          nodes: string[];
        }[] = [];
        for (const [at, end] of writers.entries()) {
          const { writer } = end;
          const list = lists[at] as TreeList;
          const saw = cutOf(click.saw, list.kind, end);
          // A press that saw records this copy lacks is not yet a cut of it: wait for the sync.
          if (saw && !covers(writer.doc, saw)) throw new PressUnsynced();
          const pending = pendingRecords(writer.doc, draftId);
          const draft = writer.view({ draft: draftId });
          const mine = items.filter((it) => it.list === list);
          // The item's records: the click asked for its tree records, or it has a pending create.
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
                click.commandId,
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
          if (!applied) continue;
          const { copies } = applied;
          rows.push({
            scope: list.kind,
            mark: encodedVersionOf(writer.doc),
            created: copies.flatMap((copy) => (copy.type === "create" ? [copy.node] : [])),
            nodes: [...new Set(copies.map((copy) => copy.node))],
          });
        }
        // Every judgement above was a guess for a source whose owner was not locked.
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
          mark: Buffer.from(row.mark),
          nodes: row.nodes,
        })),
      );
    if (perList.length > 0) {
      await input.arrivals?.settle([...documents]);
      for (const documentId of documents)
        deferUntilDrizzleCommit(() => input.onCommitted(documentId));
    }
    return landed;
  }

  return { lockItems, apply };
}

/** The vector of `cut` for the list `end` copies; none when the cut names another list. */
function cutOf(cut: TreeCut | undefined, scope: TreeList["kind"], end: ListWriter) {
  const one = cut?.[scope];
  return one && one.list === end.list ? one.vector : undefined;
}
