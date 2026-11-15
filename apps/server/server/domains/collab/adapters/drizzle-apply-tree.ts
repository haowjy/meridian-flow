/**
 * Tree half of Apply: the drafted records of one or several nodes become live copies in the
 * lists that hold them (`applyDraft`), in the click's transaction, and the command keeps what
 * Un-Apply needs of each list (`apply_command_trees`). Text Apply is the caller's.
 *
 * Lock order, as `collab/.context/CONTEXT.md` has it: the caller holds the Work and the branch;
 * the lists' keys come next, then the documents', and only then the writes (`submit`, the closed
 * drafts' resync) that touch the rows derivation locks under those document keys.
 */

import type { BranchId, CommandId, DocumentId, UserId } from "@meridian/contracts";
import { draftItemKey } from "@meridian/contracts";
import type { AppliedReviewItem, TreeSaw } from "@meridian/contracts/branches";
import type { LeftOutWhy, Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import {
  applyCommandTrees,
  documentDrafts,
  documentYjsUpdates,
  draftWriteJournal,
} from "@meridian/database/schema";
import {
  applyDraft,
  covers,
  LIVE,
  pendingRecords,
  recordsOfItem,
  type TreeRecord,
} from "@meridian/project-tree";
import { and, eq, inArray, max } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import { LIVE_TREE, type TreeReader } from "../../context/tree/tree-view.js";
import { ApplyClickUnsynced } from "../domain/apply-click.js";
import type { BranchDocumentTree } from "../domain/ports/branch-tree-state.js";
import { treeListOfNode } from "./drizzle-branch-tree-lists.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { lastSettlementOf } from "./drizzle-settlement-of.js";

export type TreeApplyOutcome = {
  applied: AppliedReviewItem[];
  /** What came back instead of landing, per item (`already`, `overtaken`, `left_out`), and what was restored. */
  settled: Settlement[];
  /** Items whose tree half did not resolve (left out or overtaken): their text stays pending too. */
  held: ReadonlySet<string>;
};

/** One node of an Apply, as the click read it. */
export type TreeApplyItem = {
  node: string;
  /** The click includes the node's tree records. */
  tree: boolean;
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
   * stand on, and the earlier records of the same facts, as one command. It never refuses: an
   * item with nothing pending is `already` (an Apply took the records) or `overtaken` (a Discard
   * did), and a record that cannot land stays pending and is `left_out` with why. `saw` is each
   * list's state vector at the press; records admitted after it are left out too. A document
   * live has in Trash comes back before its records land.
   */
  async function apply(click: {
    branchId: BranchId;
    userId: UserId;
    commandId: CommandId;
    saw: TreeSaw | undefined;
    items: readonly TreeApplyItem[];
  }): Promise<TreeApplyOutcome> {
    const { branchId, items } = click;
    // Every item's document is held under the lists' keys, in id order: the text half of the
    // command writes under them too.
    const lockItems = async () => {
      const tx = currentDrizzleDb(input.db);
      for (const node of items.map((it) => it.node).sort())
        await lockDocumentMutation(tx, node as DocumentId);
    };
    // A deleted document comes back whenever the click lands records on it, except a delete the
    // writer's own view showed (a document deleted by this click is not restored by it).
    const restoring = (it: TreeApplyItem) =>
      it.item?.deletedLive === true && it.item.change !== "deleting";
    const landing = (it: TreeApplyItem) => it.tree || it.item?.isNew === true;
    const active = items.filter((it) => landing(it) || restoring(it));
    if (active.length === 0) {
      await lockItems();
      return { applied: [], settled: [], held: new Set() };
    }

    const lists: TreeList[] = [];
    const listOf = new Map<string, TreeList>();
    const held = new Set<string>();
    const settled: Settlement[] = [];
    for (const it of active) {
      const list = await treeListOfNode(input.db, it.node);
      if (!list) {
        // No list holds the node: it was purged.
        held.add(it.node);
        settled.push({ rule: "left_out", items: [it.node], why: "purged" });
        continue;
      }
      const known = lists.find((other) => sameList(other, list)) ?? list;
      if (known === list) lists.push(list);
      listOf.set(it.node, known);
    }
    const here = active.filter((it) => listOf.has(it.node));
    if (here.length === 0) {
      await lockItems();
      return { applied: [], settled, held };
    }
    const actor = `user:${click.userId}`;
    // The lists' keys, then the documents', before anything writes: the lists' rows and the
    // closed drafts' resync below are written under both.
    await input.treeLists.lock(lists);
    const tx = currentDrizzleDb(input.db);
    await lockItems();
    // Where each document is in live now, to say where the Apply moved it.
    const documents = here.flatMap((it) => (it.item ? [it.node as DocumentId] : []));
    const before = await input.tree.identityStatus(LIVE_TREE, documents);

    const { result } = await input.treeLists.submit({
      lists,
      make: (writers) => {
        const landed = new Set<string>();
        const restoredNodes = new Set<string>();
        const perList: {
          scope: "project" | "account";
          mark: Uint8Array;
          created: string[];
          restored: string[];
          nodes: string[];
        }[] = [];
        for (const [at, { writer }] of writers.entries()) {
          const list = lists[at] as TreeList;
          const encoded = list.kind === "project" ? click.saw?.project : click.saw?.account;
          const saw = encoded ? new Uint8Array(Buffer.from(encoded, "base64")) : undefined;
          // A press that saw records this copy lacks is not yet a cut of it: wait for the sync.
          if (saw && !covers(writer.doc, saw)) throw new ApplyClickUnsynced();
          const pending = pendingRecords(writer.doc, branchId);
          const draft = writer.view({ draft: branchId });
          const settlementOf = lastSettlementOf(writer.doc, branchId);
          const mine = here.filter((it) => listOf.get(it.node) === list);
          const chosen = new Map<string, TreeRecord[]>();
          for (const it of mine) {
            if (!landing(it)) continue;
            const records = recordsOfItem(draft, pending, it.node);
            if (records.length > 0) {
              chosen.set(it.node, records);
              continue;
            }
            const last = settlementOf(it.node);
            if (last?.kind === "applied")
              settled.push({ rule: "already", state: "applied", item: it.node });
            else if (last) {
              held.add(it.node);
              settled.push({
                rule: "overtaken",
                state: "discarded",
                by: last.command as CommandId,
                item: it.node,
              });
            } else {
              held.add(it.node);
              settled.push({ rule: "left_out", items: [it.node], why: "purged" });
            }
          }
          // The restores come first and are the command's: Un-Apply takes them back with the copies.
          const restored: string[] = [];
          const restoredHere: string[] = [];
          for (const it of mine) {
            if (!restoring(it) || held.has(it.node)) continue;
            if (writer.view(LIVE).nodes.get(it.node)?.trashed === true) {
              restored.push(writer.restore(LIVE, actor, it.node).id);
              restoredHere.push(it.node);
              restoredNodes.add(it.node);
            }
          }
          const applied =
            chosen.size === 0
              ? null
              : applyDraft(
                  writer,
                  branchId,
                  actor,
                  click.commandId,
                  [...chosen.values()].flatMap((records) => records.map((record) => record.id)),
                  saw,
                );
          if (applied) {
            for (const { node } of applied.lifted) restoredNodes.add(node);
            const live = writer.view(LIVE);
            for (const node of chosen.keys())
              if (recordsOfItem(live, applied.copies, node).length > 0) landed.add(node);
            // What stayed pending, and why: a node with nothing landed holds its text back.
            const byWhy = new Map<LeftOutWhy, Set<string>>();
            for (const { record, why } of applied.left) {
              if (!landed.has(record.node) && chosen.has(record.node)) held.add(record.node);
              byWhy.set(why, (byWhy.get(why) ?? new Set()).add(record.node));
            }
            for (const [why, nodes] of byWhy)
              settled.push({ rule: "left_out", items: [...nodes], why });
          }
          if (!applied && restored.length === 0) continue;
          perList.push({
            scope: list.kind,
            mark: Y.encodeStateVector(writer.doc),
            created: (applied?.copies ?? []).flatMap((copy) =>
              copy.type === "create" ? [copy.node] : [],
            ),
            restored,
            nodes: [
              ...new Set([...restoredHere, ...(applied?.copies ?? []).map((copy) => copy.node)]),
            ],
          });
        }
        return { landed, restoredNodes, perList };
      },
    });

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
    for (const it of here) {
      if (held.has(it.node) || !(result.landed.has(it.node) || result.restoredNodes.has(it.node)))
        continue;
      const status = after.get(it.node as DocumentId);
      const to = status?.kind === "visible" ? status.address.uri : null;
      const wasAt = before.get(it.node as DocumentId);
      const renamed =
        it.item?.uri && to && it.item.uri !== to
          ? { code: "renamed" as const, wanted: it.item.uri, path: to }
          : undefined;
      applied.push({
        itemKey: draftItemKey(branchId, it.node as DocumentId),
        ...(result.landed.has(it.node)
          ? { transition: { from: wasAt?.kind === "visible" ? wasAt.address.uri : null, to } }
          : {}),
        ...(renamed ? { renamed } : {}),
      });
    }
    for (const documentId of result.restoredNodes) settled.push({ rule: "restored", documentId });

    const deleting = here.flatMap((it) =>
      it.item?.change === "deleting" && result.landed.has(it.node) ? [it.node as DocumentId] : [],
    );
    if (deleting.length > 0) {
      // Their live rooms stay open: a document in Trash still takes text until it is purged.
      await input.close.closeDrafts(
        tx,
        { documentIds: deleting, branchId },
        "document_discarded",
        click.commandId,
      );
    }
    await input.arrivals?.settle(documents);
    for (const documentId of documents)
      deferUntilDrizzleCommit(() => input.onCommitted(documentId));
    return { applied, settled, held };
  }

  /**
   * The journal rows each created document has once the command's text is in: Un-Apply refuses
   * as `gone` when one has more (`textWrittenSince`).
   */
  async function recordCreatedHeads(commandId: CommandId): Promise<void> {
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
