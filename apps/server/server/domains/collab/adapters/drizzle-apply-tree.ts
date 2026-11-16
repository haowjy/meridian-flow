/**
 * Tree half of Apply: the drafted records of the click's items become live copies in the lists
 * that hold them (`applyDraft`), in the click's transaction, and the command keeps what Un-Apply
 * needs of each list (`apply_command_trees`). It reports facts, per item, read from the lists
 * under their keys; the caller (`drizzle-apply-click.ts`) decides every answer and the text half.
 *
 * Lock order, as `collab/.context/CONTEXT.md` has it: the caller holds the Work and the branch;
 * the lists' keys come next (`lockItems`), then the documents', and only then the writes.
 */

import type { BranchId, CommandId, DocumentId, UserId } from "@meridian/contracts";
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
  deletesCovering,
  type LeftRecord,
  LIVE,
  pendingRecords,
  recordsOfItem,
  type TreeRecord,
} from "@meridian/project-tree";
import { and, eq, inArray, max } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { SourceFate, TreeJudge } from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import { type IdentityStatus, LIVE_TREE, type TreeReader } from "../../context/tree/tree-view.js";
import { ApplyClickUnsynced, type TreeCut } from "../domain/apply-click.js";
import { treeListOfNode } from "./drizzle-branch-tree-lists.js";
import { cutOf } from "./drizzle-settlement-of.js";

/** One item of an Apply as the tree half reads it. */
export type TreeApplyItem = {
  node: string;
  /** The list that holds the node; null when none does (purged). */
  list: TreeList | null;
  /** The click includes the node's tree records. */
  tree: boolean;
  /** Its text half will land if the document stands in live: a restore may bring it back for it. */
  textOpen: boolean;
};

/** What the tree half did for one item, read after its records and restores are in. */
export type TreeItemFacts = {
  /** A document, not a folder: it has a live address and text. */
  document: boolean;
  /** The tree half ran: the click asked for the item's records, or it has a pending create. */
  ran: boolean;
  /** The item's records this command chose (`recordsOfItem`), and the fate of each. */
  records: TreeRecord[];
  left: LeftRecord[];
  superseded: TreeRecord[];
  /** A landed move or rename of it brought it back from Trash. */
  lifted: boolean;
  /** The live restore this command made of it so its text could land: the record's id. */
  restore: string | null;
  /** A delete this command appended covers it in live. */
  deletedHere: boolean;
  /** It stands in live (not in Trash, not only in the draft). */
  standsInLive: boolean;
  /** Its document stands in notes that take no change (closed, or purged): its text takes no write. */
  textClosed: SourceFate | null;
  /** Where live had it before and after, for a document. */
  before?: IdentityStatus;
  after?: IdentityStatus;
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
   * facts, as one `applyDraft` per list, limited to `saw`. A document whose text will land and
   * that live has in Trash comes back: before the copies when its records hold no delete, after
   * them when they held one that did not land and nothing of this command deleted it.
   */
  async function apply(click: {
    branchId: BranchId;
    userId: UserId;
    commandId: CommandId;
    saw: TreeCut | undefined;
    items: readonly TreeApplyItem[];
    /** Under the owners' locks: what each source takes. */
    judge: TreeJudge;
  }): Promise<Map<string, TreeItemFacts>> {
    const { branchId, items } = click;
    const lists: TreeList[] = [];
    for (const { list } of items) if (list && !lists.includes(list)) lists.push(list);
    const facts = new Map<string, TreeItemFacts>();
    const blank = (): TreeItemFacts => ({
      document: true,
      ran: false,
      records: [],
      left: [],
      superseded: [],
      lifted: false,
      restore: null,
      deletedHere: false,
      standsInLive: false,
      textClosed: null,
    });
    for (const it of items) facts.set(it.node, blank());
    if (lists.length === 0) return facts;
    const placed = items.flatMap((it) => (it.list ? [it.node as DocumentId] : []));
    const before = await input.tree.identityStatus(LIVE_TREE, placed);
    const actor = `user:${click.userId}`;

    const { result: perList } = await input.treeLists.submit({
      lists,
      make: (writers) => {
        const rows: {
          scope: "project" | "account";
          mark: Uint8Array;
          created: string[];
          restored: string[];
          nodes: string[];
        }[] = [];
        for (const [at, end] of writers.entries()) {
          const { writer } = end;
          const list = lists[at] as TreeList;
          const saw = cutOf(click.saw, list.kind, end);
          // A press that saw records this copy lacks is not yet a cut of it: wait for the sync.
          if (saw && !covers(writer.doc, saw)) throw new ApplyClickUnsynced();
          const pending = pendingRecords(writer.doc, branchId);
          const draft = writer.view({ draft: branchId });
          const mine = items.filter((it) => it.list === list);
          for (const it of mine) {
            const one = facts.get(it.node) as TreeItemFacts;
            one.document =
              (draft.nodes.get(it.node) ?? writer.view(LIVE).nodes.get(it.node))?.kind !== "folder";
            one.ran =
              it.tree ||
              pending.some((record) => record.type === "create" && record.node === it.node);
            if (one.ran) one.records = recordsOfItem(draft, pending, it.node);
          }
          const holdsDelete = (it: TreeApplyItem) =>
            (facts.get(it.node) as TreeItemFacts).records.some(
              (record) => record.type === "delete",
            );
          const trashed = (node: string) => writer.view(LIVE).nodes.get(node)?.trashed === true;
          // A document in a closed owner's notes takes no text, so nothing brings it back for one.
          const placedIn = (node: string) => writer.view(LIVE).nodes.get(node)?.source;
          for (const it of mine) {
            const source = placedIn(it.node);
            (facts.get(it.node) as TreeItemFacts).textClosed =
              source === undefined ? null : click.judge.fate(source);
          }
          const textOpen = (it: TreeApplyItem) =>
            it.textOpen && !(facts.get(it.node) as TreeItemFacts).textClosed;
          // The restores this command makes are its own: Un-Apply takes them back with the copies.
          const restored: string[] = [];
          const restore = (it: TreeApplyItem) => {
            const { id } = writer.restore(LIVE, actor, it.node);
            restored.push(id);
            (facts.get(it.node) as TreeItemFacts).restore = id;
          };
          // No delete of this command can land on these, and the Work's view the copies are
          // checked against then has them standing.
          const isDocument = (it: TreeApplyItem) => (facts.get(it.node) as TreeItemFacts).document;
          for (const it of mine)
            if (isDocument(it) && textOpen(it) && !holdsDelete(it) && trashed(it.node)) restore(it);
          const chosen = mine.flatMap((it) => (facts.get(it.node) as TreeItemFacts).records);
          const applied = chosen.length
            ? applyDraft(
                writer,
                branchId,
                actor,
                click.commandId,
                [...new Set(chosen.map((record) => record.id))],
                saw,
                click.judge.closed,
              )
            : null;
          const deletes = new Set(
            (applied?.copies ?? []).flatMap((copy) => (copy.type === "delete" ? [copy.id] : [])),
          );
          const live = writer.view(LIVE);
          for (const it of mine) {
            const one = facts.get(it.node) as TreeItemFacts;
            const ids = new Set(one.records.map((record) => record.id));
            one.left = (applied?.left ?? []).filter(({ record }) => ids.has(record.id));
            one.superseded = (applied?.superseded ?? []).filter((record) => ids.has(record.id));
            one.lifted = (applied?.lifted ?? []).some(({ node }) => node === it.node);
            // Coverage at each folder on the way up, past a nearer delete that is not this command's.
            one.deletedHere =
              deletes.size > 0 &&
              deletesCovering(live, it.node).some((entry) => deletes.has(entry.id));
          }
          // A document whose own delete did not land: before the copies it was not known whether it would.
          for (const it of mine) {
            const one = facts.get(it.node) as TreeItemFacts;
            if (
              isDocument(it) &&
              textOpen(it) &&
              holdsDelete(it) &&
              !one.deletedHere &&
              trashed(it.node)
            )
              restore(it);
          }
          const final = writer.view(LIVE);
          for (const it of mine) {
            const node = final.nodes.get(it.node);
            (facts.get(it.node) as TreeItemFacts).standsInLive =
              node !== undefined && !node.trashed;
          }
          if (!applied && restored.length === 0) continue;
          const copies = applied?.copies ?? [];
          rows.push({
            scope: list.kind,
            mark: Y.encodeStateVector(writer.doc),
            created: copies.flatMap((copy) => (copy.type === "create" ? [copy.node] : [])),
            restored,
            nodes: [
              ...new Set([
                ...mine.flatMap((it) =>
                  (facts.get(it.node) as TreeItemFacts).restore ? [it.node] : [],
                ),
                ...copies.map((copy) => copy.node),
              ]),
            ],
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
    const documents = placed.filter((node) => (facts.get(node) as TreeItemFacts).document);
    const after = await input.tree.identityStatus(LIVE_TREE, documents);
    for (const node of documents) {
      const one = facts.get(node) as TreeItemFacts;
      const was = before.get(node);
      const is = after.get(node);
      if (was) one.before = was;
      if (is) one.after = is;
    }
    if (perList.length > 0) {
      await input.arrivals?.settle(documents);
      for (const documentId of documents)
        deferUntilDrizzleCommit(() => input.onCommitted(documentId));
    }
    return facts;
  }

  /**
   * The journal rows each created document has once the command's text is in: Un-Apply leaves
   * a created document with more (`has_text`, from `textWrittenSince`).
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

  return { lockItems, apply, recordCreatedHeads };
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
