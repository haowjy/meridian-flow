/**
 * Tree half of Apply: the drafted records of one or several nodes become live copies in the
 * lists that hold them (`applyDraft`), in the click's transaction, and the command keeps what
 * Un-Apply needs of each list (`apply_command_trees`). Text Apply is the caller's.
 *
 * Lock order, as `collab/.context/CONTEXT.md` has it: the caller holds the Work and the branch;
 * the lists' keys come next, then the documents', and only then the writes (`submit`, the closed
 * drafts' resync) that touch the rows derivation locks under those document keys.
 */

import type { BranchId, DocumentCommandId, DocumentId, UserId } from "@meridian/contracts";
import { draftItemKey } from "@meridian/contracts";
import type { AppliedReviewItem } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import {
  applyCommandTrees,
  documentDrafts,
  documentYjsUpdates,
  draftWriteJournal,
} from "@meridian/database/schema";
import { applyDraft, LIVE, pendingRecords, type TreeRecord } from "@meridian/project-tree";
import { and, eq, inArray, max } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import { LIVE_TREE, type TreeReader } from "../../context/tree/tree-view.js";
import { ApplyClickRefused } from "../domain/apply-click.js";
import type { BranchDocumentTree } from "../domain/ports/branch-tree-state.js";
import { recordsOfItem, treeListOfNode } from "./drizzle-branch-tree-lists.js";
import type { DraftClose } from "./drizzle-draft-close.js";

export type TreeApplyOutcome =
  | { kind: "applied"; applied: AppliedReviewItem[]; restored: boolean }
  | { kind: "changed" }
  | { kind: "needs_restore" };

/** One node of an Apply, as the click read it. */
export type TreeApplyItem = {
  node: string;
  /** The revision the click froze; null: a click with no tree cut (a creation revealed whole). */
  cut: { revision: string | null } | null;
  /** The Work's row on the node now (`branchRowRevisions`); undefined: none. */
  revision: string | undefined;
  /** The review item, for a document. */
  item: BranchDocumentTree | null;
};

const sameList = (a: TreeList, b: TreeList) =>
  a.kind === b.kind &&
  (a.kind === "project"
    ? a.projectId === (b as typeof a).projectId
    : a.userId === (b as typeof a).userId);

export function createApplyTreeOperations(input: {
  db: Database;
  treeLists: Pick<TreeListStore, "lock" | "submit">;
  tree: Pick<TreeReader, "identityStatus">;
  close: Pick<DraftClose, "closeDrafts">;
  arrivals?: Pick<DocumentArrivals, "settle">;
  onCommitted(documentId: DocumentId): Promise<void>;
}) {
  /**
   * Applies what the Work has pending on each item: its own records, the drafted creates they
   * stand on, and the earlier records of the same facts, as one command. An item with a `cut`
   * must still have the revision the writer saw, else the answer is `changed` and nothing
   * applies. Without a cut, the records land only when the document exists only in the Work (a
   * creation is revealed whole); a document live has in Trash is restored first when the click
   * carries `restore`. An item whose records cannot land stays pending and is left out of the
   * answer; none landing is refused (`ancestor_taken`).
   */
  async function apply(click: {
    branchId: BranchId;
    userId: UserId;
    commandId: DocumentCommandId;
    restore: boolean;
    items: readonly TreeApplyItem[];
  }): Promise<TreeApplyOutcome> {
    const { branchId, items } = click;
    if (
      items.some(
        ({ cut, revision }) => cut && (revision === undefined || revision !== cut.revision),
      )
    )
      return { kind: "changed" };
    // Every item's document is held under the lists' keys, in id order: the text half of the
    // command writes under them too.
    const lockItems = async () => {
      const tx = currentDrizzleDb(input.db);
      for (const node of items.map((it) => it.node).sort())
        await lockDocumentMutation(tx, node as DocumentId);
    };
    // Only the writer's knowledge brings a deleted document back: a delete their view did not
    // show leaves the click undone and the draft pending.
    const restoring = (it: TreeApplyItem) =>
      it.item?.deletedLive === true && it.item.change !== "deleting";
    if (!click.restore && items.some(restoring)) return { kind: "needs_restore" };
    const landing = (it: TreeApplyItem) => it.cut !== null || it.item?.isNew === true;
    const active = items.filter((it) => landing(it) || restoring(it));
    if (active.length === 0) {
      await lockItems();
      return { kind: "applied", applied: [], restored: false };
    }

    const lists: TreeList[] = [];
    const listOf = new Map<string, TreeList>();
    for (const it of active) {
      const list = await treeListOfNode(input.db, it.node);
      if (!list) throw new ApplyClickRefused("not_found");
      const known = lists.find((other) => sameList(other, list)) ?? list;
      if (known === list) lists.push(list);
      listOf.set(it.node, known);
    }
    const actor = `user:${click.userId}`;
    // The lists' keys, then the documents', before anything writes: the lists' rows and the
    // closed drafts' resync below are written under both.
    await input.treeLists.lock(lists);
    const tx = currentDrizzleDb(input.db);
    await lockItems();
    // Where each document is in live now, to say where the Apply moved it.
    const documents = active.flatMap((it) => (it.item ? [it.node as DocumentId] : []));
    const before = await input.tree.identityStatus(LIVE_TREE, documents);

    const { result } = await input.treeLists.submit({
      lists,
      make: (writers) => {
        // Nothing is written before the answer is known: a "changed" click stores no restore.
        const chosen = new Map<string, TreeRecord[]>();
        for (const [at, { writer }] of writers.entries()) {
          const pending = pendingRecords(writer.doc, branchId);
          for (const it of active) {
            if (listOf.get(it.node) !== lists[at] || !landing(it)) continue;
            const records = recordsOfItem(pending, it.node as DocumentId);
            if (records.length === 0) return "changed" as const;
            chosen.set(it.node, records);
          }
        }
        const landed = new Set<string>();
        const perList: {
          scope: "project" | "account";
          mark: Uint8Array;
          created: string[];
          restored: string[];
          nodes: string[];
        }[] = [];
        for (const [at, { writer }] of writers.entries()) {
          const list = lists[at] as TreeList;
          // The restores come first and are the command's: Un-Apply takes them back with the copies.
          const restored: string[] = [];
          const restoredNodes: string[] = [];
          for (const it of active) {
            if (listOf.get(it.node) !== list || !restoring(it)) continue;
            if (writer.view(LIVE).nodes.get(it.node)?.trashed === true) {
              restored.push(writer.restore(LIVE, actor, it.node).id);
              restoredNodes.push(it.node);
            }
          }
          const mine = active.filter((it) => listOf.get(it.node) === list && chosen.has(it.node));
          const applied =
            mine.length === 0
              ? null
              : applyDraft(
                  writer,
                  branchId,
                  actor,
                  click.commandId,
                  mine.flatMap((it) => (chosen.get(it.node) ?? []).map((record) => record.id)),
                );
          for (const it of mine)
            if (recordsOfItem(applied?.copies ?? [], it.node as DocumentId).length > 0)
              landed.add(it.node);
          if (!applied && restored.length === 0) continue;
          perList.push({
            scope: list.kind,
            mark: applied?.mark ?? Y.encodeStateVector(writer.doc),
            created: (applied?.copies ?? []).flatMap((copy) =>
              copy.type === "create" ? [copy.node] : [],
            ),
            restored,
            nodes: [
              ...new Set([...restoredNodes, ...(applied?.copies ?? []).map((copy) => copy.node)]),
            ],
          });
        }
        // A record that cannot land (a move into itself, a change to what live has in Trash)
        // lands nothing of its item: the item stays pending, and with none landed the click
        // is refused.
        if (landed.size === 0 && chosen.size > 0) throw new ApplyClickRefused("ancestor_taken");
        return { landed, perList };
      },
    });
    if (result === "changed") return { kind: "changed" };

    if (result.perList.length > 0)
      await tx.insert(applyCommandTrees).values(
        result.perList.map((row) => ({
          commandId: click.commandId,
          branchId,
          scope: row.scope,
          mark: Buffer.from(row.mark),
          createdHeads: Object.fromEntries(
            row.created.map((node) => [node, { live: 0, draft: 0 }]),
          ),
          restored: row.restored,
          nodes: row.nodes,
        })),
      );

    const after = await input.tree.identityStatus(LIVE_TREE, documents);
    const applied: AppliedReviewItem[] = [];
    for (const it of active) {
      const status = after.get(it.node as DocumentId);
      const to = status?.kind === "visible" ? status.address.uri : null;
      const wasAt = before.get(it.node as DocumentId);
      const renamed =
        it.item?.uri && to && it.item.uri !== to
          ? { code: "renamed" as const, wanted: it.item.uri, path: to }
          : undefined;
      if (!landing(it) && !restoring(it)) continue;
      applied.push({
        itemKey: draftItemKey(branchId, it.node as DocumentId),
        ...(result.landed.has(it.node)
          ? { transition: { from: wasAt?.kind === "visible" ? wasAt.address.uri : null, to } }
          : {}),
        ...(renamed ? { renamed } : {}),
      });
    }

    const deleting = active.flatMap((it) =>
      it.item?.change === "deleting" ? [it.node as DocumentId] : [],
    );
    if (deleting.length > 0) {
      // Their live rooms stay open: a document in Trash still takes text until it is purged.
      await input.close.closeDrafts(tx, { documentIds: deleting, branchId }, "document_discarded");
    }
    await input.arrivals?.settle(documents);
    for (const documentId of documents)
      deferUntilDrizzleCommit(() => input.onCommitted(documentId));
    return {
      kind: "applied",
      applied,
      restored: click.restore && items.some(restoring),
    };
  }

  /**
   * The journal rows each created document has once the command's text is in: Un-Apply refuses
   * as `gone` when one has more (`textWrittenSince`).
   */
  async function recordCreatedHeads(commandId: DocumentCommandId): Promise<void> {
    const tx = currentDrizzleDb(input.db);
    const rows = await tx
      .select({ scope: applyCommandTrees.scope, heads: applyCommandTrees.createdHeads })
      .from(applyCommandTrees)
      .where(eq(applyCommandTrees.commandId, commandId));
    for (const { scope, heads } of rows) {
      const nodes = Object.keys(heads) as DocumentId[];
      if (nodes.length === 0) continue;
      await tx
        .update(applyCommandTrees)
        .set({ createdHeads: await journalHeads(tx, nodes) })
        .where(and(eq(applyCommandTrees.commandId, commandId), eq(applyCommandTrees.scope, scope)));
    }
  }

  return { apply, recordCreatedHeads };
}

type Tx = ReturnType<typeof currentDrizzleDb>;

/** The highest live and draft journal row of each document (0 for none). */
async function journalHeads(tx: Tx, documentIds: readonly DocumentId[]) {
  const live = await tx
    .select({ id: documentYjsUpdates.documentId, head: max(documentYjsUpdates.id) })
    .from(documentYjsUpdates)
    .where(inArray(documentYjsUpdates.documentId, [...documentIds]))
    .groupBy(documentYjsUpdates.documentId);
  const draft = await tx
    .select({ id: documentDrafts.documentId, head: max(draftWriteJournal.id) })
    .from(draftWriteJournal)
    .innerJoin(documentDrafts, eq(documentDrafts.id, draftWriteJournal.draftId))
    .where(inArray(documentDrafts.documentId, [...documentIds]))
    .groupBy(documentDrafts.documentId);
  const liveHead = new Map(live.map((row) => [row.id as string, Number(row.head ?? 0)]));
  const draftHead = new Map(draft.map((row) => [row.id as string, Number(row.head ?? 0)]));
  return Object.fromEntries(
    documentIds.map((id) => [id, { live: liveHead.get(id) ?? 0, draft: draftHead.get(id) ?? 0 }]),
  );
}

/**
 * The documents recorded in `heads` that have text written since: a live or draft journal row
 * past what the Apply left. The caller holds their document keys.
 */
export async function textWrittenSince(
  db: Database,
  heads: Record<string, { live: number; draft: number }>,
): Promise<Set<string>> {
  const nodes = Object.keys(heads) as DocumentId[];
  if (nodes.length === 0) return new Set();
  const now = await journalHeads(currentDrizzleDb(db), nodes);
  return new Set(
    nodes.filter((node) => {
      const [was, is] = [heads[node], now[node]];
      return !was || !is || is.live > was.live || is.draft > was.draft;
    }),
  );
}
