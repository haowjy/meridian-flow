/**
 * What became of each half of an item, read under the caller's list and document keys: the one
 * reader Apply (and B4's Discard) answer `already`, `overtaken` or `left_out` from, so a Discard
 * that took an item can never read as "already applied".
 */
import type { BranchId } from "@meridian/contracts";
import type { Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { documentDrafts } from "@meridian/database/schema";
import {
  listRecords,
  pendingRecords,
  recordsAdmittedAfter,
  recordsOfItem,
  settledRecords,
  type TreeRecord,
} from "@meridian/project-tree";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ListWriter, TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { TreeCut } from "../domain/apply-click.js";
import { appliesInForce } from "./drizzle-command-edits.js";

export type Settled = { kind: "applied" | "discarded" | "removed" } | { kind: "purged" };

export type ItemSettlement = {
  /** `pending`: the Work still has records that are this node's item. */
  tree: { pending: boolean; last: Settled | null };
  /**
   * `open`: the draft row is active, whether or not it holds a change; `branchId` is the branch
   * it is open in. Null: no text half asked.
   */
  text: { open: boolean; branchId: BranchId | null; last: Settled | null } | null;
};

/** The vector of `cut` for the list `end` copies; none when the cut names another list. */
export function cutOf(cut: TreeCut | undefined, scope: TreeList["kind"], end: ListWriter) {
  const one = cut?.[scope];
  return one && one.list === end.list ? one.vector : undefined;
}

/**
 * Per item, what the Work still holds of it and what settled it last. `list` is the list that
 * holds the node (null: none does, it was purged); `draftId` the text draft the press named.
 */
export async function settlementOf(
  db: Database,
  deps: { treeLists: Pick<TreeListStore, "read"> },
  branchId: BranchId,
  items: readonly { node: string; list: TreeList | null; draftId?: string }[],
  /** The press's cut of each list; records admitted after it are not the press's. */
  saw?: TreeCut,
): Promise<Map<string, ItemSettlement>> {
  const out = new Map<string, ItemSettlement>();
  const lists: TreeList[] = [];
  for (const { list } of items)
    if (list && !lists.some((known) => sameList(known, list))) lists.push(list);
  const trees = lists.length
    ? await deps.treeLists.read({
        lists,
        view: (ends) =>
          ends.map((end, at) => {
            const list = lists[at] as TreeList;
            const read = treeHalf(end, branchId, cutOf(saw, list.kind, end));
            return new Map(
              items.flatMap((item) =>
                item.list && sameList(item.list, list)
                  ? [[item.node, read(item.node)] as const]
                  : [],
              ),
            );
          }),
      })
    : [];
  const texts = await textHalf(
    db,
    items.flatMap((item) => (item.draftId ? [item.draftId] : [])),
  );
  for (const item of items)
    out.set(item.node, {
      tree: trees.find((byNode) => byNode.has(item.node))?.get(item.node) ?? {
        pending: false,
        last: { kind: "purged" },
      },
      text: item.draftId
        ? (texts.get(item.draftId) ?? { open: false, branchId: null, last: { kind: "purged" } })
        : null,
    });
  return out;
}

/** The note a command of kind `asked` gives for a half something else settled. */
export function noteOf(
  last: Settled | null,
  node: string,
  asked: "applied" | "discarded",
): Settlement {
  if (!last || last.kind === "purged") return { rule: "left_out", items: [node], why: "purged" };
  if (last.kind === asked) return { rule: "already", state: asked, item: node };
  return { rule: "overtaken", state: last.kind, item: node };
}

const sameList = (a: TreeList, b: TreeList) =>
  a.kind === b.kind &&
  (a.kind === "project"
    ? a.projectId === (b as typeof a).projectId
    : a.userId === (b as typeof a).userId);

/**
 * The tree half of one list copy. A node's candidates are the Work's settled records made on it,
 * and its deletes whose cascade names it while their folder is still above it in the Work's
 * view: the cascade is what the delete's author saw, and a node that left the folder is no
 * longer covered. With a cut, a record admitted after it was not seen and is no candidate; the
 * one settled latest answers. With none, the node's own records win: they are the ones the press
 * certainly saw.
 */
function treeHalf(end: ListWriter, branchId: BranchId, saw: Uint8Array | undefined) {
  const { writer } = end;
  const draft = writer.view({ draft: branchId });
  const pending = pendingRecords(writer.doc, branchId);
  const last = settledRecords(writer.doc);
  const unseen = saw ? recordsAdmittedAfter(writer.doc, saw) : new Set<string>();
  const settled = listRecords(writer.doc).flatMap((record) => {
    if (record.draft !== branchId || unseen.has(record.id)) return [];
    const settle = last.get(record.id);
    if (!settle?.command || settle.fate === "dropped") return [];
    // A record replaced by a later one an Apply landed: that Apply took the node's item.
    const kind = settle.fate === "discarded" ? ("discarded" as const) : ("applied" as const);
    return [{ record, kind, at: settle.at }];
  });
  const above = (folder: string, node: string) => {
    for (let at = draft.nodes.get(node); at; at = draft.nodes.get(at.parent))
      if (at.parent === folder) return true;
    return false;
  };
  const latest = (of: typeof settled) =>
    of.reduce<(typeof settled)[number] | null>(
      (best, one) => (!best || one.at > best.at ? one : best),
      null,
    );
  return (node: string): ItemSettlement["tree"] => {
    const own = settled.filter(({ record }) => record.node === node);
    const covering = settled.filter(
      ({ record }) => isDelete(record) && record.cascade.includes(node) && above(record.node, node),
    );
    const found = latest(saw ? [...own, ...covering] : own.length ? own : covering);
    return {
      pending: recordsOfItem(draft, pending, node).length > 0,
      last: found ? { kind: found.kind } : null,
    };
  };
}

const isDelete = (record: TreeRecord): record is Extract<TreeRecord, { type: "delete" }> =>
  record.type === "delete";

/**
 * The text half, by draft row: the command of its latest effect still applied, as `applied`, else
 * null. A draft with no row was purged: it is absent here.
 */
async function textHalf(db: Database, draftIds: readonly string[]) {
  const out = new Map<string, NonNullable<ItemSettlement["text"]>>();
  if (draftIds.length === 0) return out;
  const tx = currentDrizzleDb(db);
  const rows = await tx
    .select({ id: documentDrafts.id, branchId: documentDrafts.branchId })
    .from(documentDrafts)
    .where(inArray(documentDrafts.id, [...draftIds]));
  const open = rows.map((row) => row.id);
  const applied = new Set((await appliesInForce(tx, open)).map((part) => part.draftId));
  for (const row of rows) {
    out.set(row.id, {
      open: true,
      branchId: row.branchId,
      last: applied.has(row.id) ? { kind: "applied" } : null,
    });
  }
  return out;
}
