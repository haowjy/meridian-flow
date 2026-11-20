/**
 * Atomic Apply: Work lock, command claim, committed live effect and prefix-authored base.
 * One executor for any selection of nodes, folders included. Under the Work, branch, list and
 * document keys it reads what settled each item (`settlementOf`), lands the tree cuts in the
 * lists that hold the drafted records (`drizzle-apply-tree.ts`), then merges each document's
 * text at the result. Each half of an item is answered on its own evidence: the text lands
 * wherever its draft is open and its document stands in live, whatever the tree half did. The
 * command keeps both halves (`apply_command_trees`, and an `apply` edit per document whose parts
 * hold what each group changed in Live), and Un-Apply takes back all of it, across every
 * document: its text half is the one Undo of a writer's command (`undoCommandText`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  addCounts,
  applyBase,
  captureDelta,
  contentMerge,
  type RuleCounts,
  ruleCounter,
  type StoredDelta,
} from "@meridian/agent-edit/content-merge";
import { REVIEW_BASE_FRAGMENT, readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { type BranchId, type DocumentId, draftItemKey, type UserId } from "@meridian/contracts";
import type {
  AppliedReviewItem,
  ApplyClickResult,
  ApplyHalfResult,
  ApplyItemResult,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import type { Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import {
  applyCommandTrees,
  branches,
  commands,
  documentDrafts,
  treeNodes,
} from "@meridian/database/schema";
import {
  appliedCreates,
  LIVE,
  madeBy,
  pendingRecords,
  type TreeWriter,
  undoApply,
} from "@meridian/project-tree";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import {
  returnedFor,
  type SourceFate,
  type TreeJudge,
  withTreeOwners,
} from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { TreeReader } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { ApplyCommand, ApplyCommandStore, PreparedApplyItem } from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { storedDocument } from "../domain/stored-document.js";
import {
  createApplyTreeOperations,
  type TreeItemFacts,
  textWrittenSince,
} from "./drizzle-apply-tree.js";
import { treeListOfNode, treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { documentsOfCommand, undoCommandText } from "./drizzle-command-edits.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";
import {
  type ItemSettlement,
  noteOf,
  type Settled,
  settlementOf,
} from "./drizzle-settlement-of.js";

const applyTiming = new AsyncLocalStorage<{
  commandId: string;
  measured: (input: { commandId: string; holdMs: number }) => void;
}>();

/** Uses the append door's actual lock-to-root-commit time, not the server author's CPU time. */
export function measureApplyAppend(detail: { holdMs: number }): void {
  const timing = applyTiming.getStore();
  timing?.measured({ commandId: timing.commandId, holdMs: detail.holdMs });
}

/** The line for notes that take no change: `returned` for a closed owner's, `left_out purged` for a purged Work's. */
function fateNote(fate: SourceFate, node: string): Settlement {
  return fate.kind === "gone"
    ? { rule: "left_out", items: [node], why: "purged" }
    : returnedFor(fate);
}

/** The lines for the records of the item's tree half that would change notes that take no change. */
function closedNotes(one: TreeItemFacts, judge: TreeJudge, node: string): Settlement[] {
  const fates = new Map<string, SourceFate>();
  for (const { why, source } of one.left) {
    const fate = why === "closed" && source !== undefined ? judge.fate(source) : null;
    if (fate) fates.set(fate.kind === "gone" ? "gone" : fate.why, fate);
  }
  return [...fates.values()].map((fate) => fateNote(fate, node));
}

/**
 * The tree half's answer from its record fates: landed when any of the item's records did, with a
 * `left_out` line per reason the rest stayed, or the `returned` line of a record that would change
 * a closed owner's notes; with nothing pending, what settled the records.
 */
function treeResult(
  node: string,
  one: TreeItemFacts,
  last: Settled | null,
  judge: TreeJudge,
): NonNullable<ApplyItemResult["tree"]> {
  const left = new Set(one.left.map(({ record }) => record.id));
  const superseded = new Set(one.superseded.map((record) => record.id));
  const landed =
    one.restore !== null ||
    one.records.some((record) => !left.has(record.id) && !superseded.has(record.id));
  const notes: Settlement[] = [
    ...closedNotes(one, judge, node),
    ...[...new Set(one.left.flatMap(({ why }) => (why === "closed" ? [] : [why])))].map(
      (why): Settlement => ({ rule: "left_out", items: [node], why }),
    ),
  ];
  if (!landed)
    return {
      landed: false,
      settled: notes.length
        ? notes
        : one.records.length
          ? [{ rule: "already", state: "applied", item: node }]
          : [noteOf(last, node, "applied")],
    };
  if (one.lifted) notes.push({ rule: "restored", documentId: node });
  const restore = one.restore ? { restore: one.restore } : {};
  if (!one.document)
    return { landed: true, ...(notes.length ? { settled: notes } : {}), ...restore };
  const from = one.before?.kind === "visible" ? one.before.address.uri : null;
  const to = one.after?.kind === "visible" ? one.after.address.uri : null;
  return {
    landed: true,
    ...(notes.length ? { settled: notes } : {}),
    ...restore,
    transition: { from, to },
  };
}

/** The items with a landed half, in the shape tabs opened before `items` read. */
function appliedOf(branchId: BranchId, results: readonly ApplyItemResult[]): AppliedReviewItem[] {
  return results.flatMap((result) => {
    const { tree } = result;
    if (!tree?.landed && !result.text?.landed) return [];
    return [
      {
        itemKey: draftItemKey(branchId, result.node as DocumentId),
        ...(tree?.landed && tree.transition ? { transition: tree.transition } : {}),
      },
    ];
  });
}

export function createDrizzleApplyClick(
  db: Database,
  deps: {
    workProjection: WorkProjectionMutation;
    branches: Pick<Branches, "lockActive" | "ownerOf" | "ensureActiveForWrite">;
    coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    arrivals?: Pick<DocumentArrivals, "settle">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    tree: Pick<TreeReader, "identityStatus">;
    onCommitted(documentId: DocumentId): Promise<void>;
    /** What the click's content merges did: how often each rule fired, and the live words the draft overrode. */
    merged(input: {
      commandId: string;
      kind: "apply" | "unapply";
      rules: RuleCounts;
      overrode: number;
    }): void;
    measured(input: {
      commandId: string;
      compileClickMs?: number;
      boundaryMs?: number;
      holdMs?: number;
    }): void;
    /** An Apply that landed nothing, after its commit: why, per item, for the log. */
    answeredWithoutLanding(input: { commandId: string; settled: Settlement[] }): void;
  },
): ApplyCommandStore {
  const treeHalf = createApplyTreeOperations({
    db,
    treeLists: deps.treeLists,
    tree: deps.tree,
    arrivals: deps.arrivals,
    onCommitted: deps.onCommitted,
  });

  /**
   * One document's text half of an Apply: its groups merge into live and into the draft's base,
   * in turn. The command's `apply` edit on the document records two parts: Live's change, and the
   * base's change with the AI changes it carried. The caller holds the document's key. Returns the
   * draft's server clock once the base write is in, for the browser's queue.
   */
  async function applyText(
    command: ApplyCommand,
    node: DocumentId,
    { base, click }: NonNullable<PreparedApplyItem["text"]>,
  ): Promise<{ overrode: number; at?: number }> {
    const tx = currentDrizzleDb(db);
    const { commandId, accountId } = command.envelope;
    const { schema } = click;
    const draftId = base.snapshot.draftId;
    const snapshot = await deps.live.read(node);
    const live = storedDocument(snapshot);
    try {
      let overrode = 0;
      const merged = ruleCounter();
      const receipts: Parameters<typeof recordDocumentEdit>[1]["receipts"] = [];
      const fragment = live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      const liveBefore = readBlocks(fragment, schema);
      const liveUpdates = captureMutationUpdates(live, () => {
        for (const group of click.groups) {
          const groupMerge = contentMerge(
            schema,
            group.before,
            readBlocks(fragment, schema),
            group.patched,
          );
          overrode += groupMerge.overrode;
          addCounts(merged.fire, groupMerge.rules);
          live.transact(() => writeBlocks(fragment, schema, groupMerge.blocks), "apply");
        }
      });
      if (liveUpdates.length) {
        const update = Y.mergeUpdates(liveUpdates);
        const seq = await deps.live.append(
          node,
          update,
          { seq: 0, origin: `human:${accountId}` },
          snapshot.authority,
        );
        receipts.push({
          update,
          effect: { inserted: [], deleted: [] },
          origin: { kind: "live", seq },
          delta: captureDelta(liveBefore, readBlocks(fragment, schema)),
        });
      }
      deps.merged({ commandId, kind: "apply", rules: merged.counts, overrode });
      await testHook("apply.afterLive");
      let at: number | undefined;
      let baseWrite: { rows: Uint8Array[]; delta: StoredDelta | null } | undefined;
      const write = deps.coordinator.prepareAppend(base, [], {
        work: "any",
        authorServerRows(prefix) {
          const fragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
          const before = readBlocks(fragment, schema);
          const rows = captureMutationUpdates(prefix, () => {
            for (const group of click.groups) {
              const after = applyBase(
                schema,
                readBlocks(fragment, schema),
                group.before,
                group.patched,
              );
              prefix.transact(() => writeBlocks(fragment, schema, after), "apply");
            }
          });
          if (rows.length) {
            at = Y.getState(prefix.store, prefix.clientID);
            baseWrite = { rows, delta: captureDelta(before, readBlocks(fragment, schema)) };
          }
          return rows;
        },
      });
      try {
        await write.persist();
        write.transfer();
      } finally {
        write.dispose();
      }
      if (baseWrite)
        receipts.push({
          update: Y.mergeUpdates(baseWrite.rows),
          effect: { inserted: [], deleted: [] },
          origin: { kind: "base", draftId },
          delta: baseWrite.delta,
          carried: click.groups.flatMap((group) => group.carried),
        });
      if (receipts.length)
        await recordDocumentEdit(tx, {
          documentId: node,
          actor: "human",
          actorUserId: accountId as UserId,
          kind: "apply",
          commandId,
          receipts,
        });
      if (liveUpdates.length)
        deferUntilDrizzleCommit(async () => {
          await deps.liveCoordinator.deliver(node);
          await deps.onCommitted(node);
        });
      return { overrode, ...(at === undefined ? {} : { at }) };
    } finally {
      live.destroy();
    }
  }

  return {
    async loadBase({ draftId, documentId, branchId }) {
      const [identity] = await currentDrizzleDb(db)
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
        .where(
          and(
            eq(documentDrafts.id, draftId),
            eq(documentDrafts.documentId, documentId as DocumentId),
            eq(documentDrafts.kind, "work_draft"),
            eq(branches.id, branchId),
            eq(branches.status, "active"),
          ),
        );
      if (!identity) return null;
      try {
        return await deps.coordinator.loadBase(draftId);
      } catch (cause) {
        // A purge deletes the draft between resolution and this read.
        const [row] = await currentDrizzleDb(db)
          .select({ id: documentDrafts.id })
          .from(documentDrafts)
          .where(eq(documentDrafts.id, draftId));
        if (!row) return null;
        throw cause;
      }
    },
    async loadUnapply(command) {
      const tx = currentDrizzleDb(db);
      const applied = command.request.applyCommandId;
      const trees = await tx
        .select({
          branchId: applyCommandTrees.branchId,
          scope: applyCommandTrees.scope,
          createdHeads: applyCommandTrees.createdHeads,
          restored: applyCommandTrees.restored,
        })
        .from(applyCommandTrees)
        .innerJoin(commands, eq(commands.id, applyCommandTrees.commandId))
        .where(
          and(
            eq(applyCommandTrees.commandId, applied),
            eq(commands.accountId, command.envelope.accountId),
            eq(commands.kind, "apply"),
          ),
        );
      const texts = await documentsOfCommand(tx, applied, command.envelope.accountId as UserId);
      if (!trees.length && !texts.length) return null;
      // The branch the Apply's drafts are on now: a Restore may have moved one since.
      const draftId = texts.flatMap((text) => text.draftIds)[0];
      const [draft] = draftId
        ? await tx
            .select({ branchId: documentDrafts.branchId })
            .from(documentDrafts)
            .where(eq(documentDrafts.id, draftId))
        : [];
      return {
        branchId: trees[0]?.branchId ?? draft?.branchId ?? command.branchId,
        texts: texts.map(({ documentId }) => ({ documentId })),
        trees,
      };
    },
    async unapply(command, found) {
      // Nothing left to take back: the command still runs, so a resend finds its answer.
      const prepared = found ?? { branchId: command.branchId, texts: [], trees: [] };
      const commandId = command.envelope.commandId;
      const applyCommandId = command.request.applyCommandId;
      const by = `user:${command.envelope.accountId}`;
      {
        // Where each document whose text the Apply wrote stands in live, by list.
        const placesOfTexts = (ends: readonly { writer: TreeWriter }[]) => {
          const out = new Map<string, string>();
          for (const { writer } of ends)
            for (const text of prepared.texts) {
              const node = writer.view(LIVE).nodes.get(text.documentId);
              if (node) out.set(text.documentId, node.source);
            }
          return out;
        };
        // The sources the Apply's copies changed (what replay reports for each), where live has
        // their nodes now, and where the texts' documents are: their owners are locked with the
        // branch's, and judged under the locks. A guess, so it can miss; a miss restarts.
        const sources = async () => {
          const lists = await treeListsOfBranch(db, prepared.branchId);
          if (lists.length === 0) return new Set<string>();
          return deps.treeLists.read({
            lists,
            view: (ends) => {
              const out = new Set<string>(placesOfTexts(ends).values());
              for (const [at, { writer }] of ends.entries()) {
                const tree = prepared.trees.find((one) => one.scope === lists[at]?.kind);
                if (!tree) continue;
                const live = writer.view(LIVE);
                for (const record of madeBy(writer.doc, applyCommandId, tree.restored)) {
                  for (const source of live.changes.get(record.id)?.sources ?? []) out.add(source);
                  const node = live.nodes.get(record.node);
                  if (node) out.add(node.source);
                }
              }
              return out;
            },
          });
        };
        return await withTreeOwners(db, sources, (owners) =>
          runDocumentCommand(db, command.envelope, () =>
            deps.workProjection.mutate(
              { branches: [prepared.branchId], works: owners.works, lineages: owners.lineages },
              async (locked): Promise<UnapplyClickResult> => {
                const tx = currentDrizzleDb(db);
                const judge = await owners.judge(locked);
                await deps.branches.lockActive(prepared.branchId);
                // The lists' keys, then the documents': the text of every document the Apply
                // created is asked about, and the tree rows are written, under both.
                const pairs = (await treeListsOfBranch(db, prepared.branchId)).flatMap((list) => {
                  const tree = prepared.trees.find((candidate) => candidate.scope === list.kind);
                  return tree ? [{ list, tree }] : [];
                });
                const lists = pairs.map(({ list }) => list);
                const branchLists = await treeListsOfBranch(db, prepared.branchId);
                // The texts' documents are read where the lists have them, under the lists' keys.
                // A text answer written under the document keys resyncs the list of a document
                // in Trash, so that list's key is taken here too.
                const trashed = prepared.texts.length
                  ? await tx
                      .select({ id: treeNodes.id })
                      .from(treeNodes)
                      .where(
                        and(
                          inArray(
                            treeNodes.id,
                            prepared.texts.map((text) => text.documentId),
                          ),
                          isNotNull(treeNodes.trashRecord),
                        ),
                      )
                  : [];
                const trashedLists: TreeList[] = [];
                for (const { id } of trashed) {
                  const list = await treeListOfNode(db, id);
                  if (list) trashedLists.push(list);
                }
                await deps.treeLists.lock([
                  ...(prepared.texts.length ? branchLists : lists),
                  ...trashedLists,
                ]);
                const created = lists.length
                  ? await deps.treeLists.read({
                      lists,
                      view: (ends) =>
                        ends.flatMap(({ writer }) => appliedCreates(writer, applyCommandId)),
                    })
                  : [];
                const documentIds = new Set<string>(created);
                for (const text of prepared.texts) documentIds.add(text.documentId);
                for (const id of [...documentIds].sort())
                  await lockDocumentMutation(tx, id as DocumentId);
                const treeUndone = new Set<string>();
                if (lists.length > 0) {
                  const written = await textWrittenSince(
                    db,
                    Object.assign({}, ...prepared.trees.map((tree) => tree.createdHeads)),
                  );
                  await deps.treeLists.submit({
                    lists,
                    make: (ends) => {
                      for (const [at, { writer }] of ends.entries()) {
                        const { tree } = pairs[at] as (typeof pairs)[number];
                        const result = undoApply(writer, applyCommandId, by, commandId, {
                          writtenSince: written,
                          restoredByApply: tree.restored,
                          closed: judge.closed,
                        });
                        for (const record of result.undone) treeUndone.add(record.node);
                      }
                    },
                  });
                }
                // A document in notes that take no change keeps its text as the Apply left it.
                // Where the document stands is read after the tree half, which may have moved it.
                const stands = prepared.texts.length
                  ? await deps.treeLists.read({ lists: branchLists, view: placesOfTexts })
                  : new Map<string, string>();
                const open = new Set<string>();
                for (const text of prepared.texts) {
                  const source = stands.get(text.documentId);
                  if (!(source !== undefined && judge.fate(source))) open.add(text.documentId);
                }
                judge.assertLocked();
                const undone = await undoCommandText(db, deps, {
                  commandId,
                  undoes: applyCommandId,
                  accountId: command.envelope.accountId as UserId,
                  only: open,
                });
                const textUndone = undone.map((one) => ({
                  node: one.documentId,
                  ...(one.at ? { at: one.at } : {}),
                }));
                return {
                  status: "unapplied",
                  commandId,
                  branchId: prepared.branchId as BranchId,
                  textUndone,
                  treeUndone: [...treeUndone],
                };
              },
              { requireActive: false, seam: true },
            ),
          ),
        );
      }
    },
    measured: deps.measured,
    async apply(command, items, saw) {
      const { branchId, envelope } = command;
      const { commandId } = envelope;
      const userId = envelope.accountId as UserId;
      await testHook("apply.beforeBoundary");
      const boundaryStart = performance.now();
      let committedAt: number | undefined;
      try {
        // The sources the branch's pending records change in the Work's view (what replay reports for
        // each), and where live has each node they and the items name: their owners are locked with
        // the branch's, and judged under the locks. A guess, so it can miss; a miss restarts.
        const sources = async () => {
          const lists = await treeListsOfBranch(db, branchId);
          if (lists.length === 0) return new Set<string>();
          return deps.treeLists.read({
            lists,
            view: (ends) => {
              const out = new Set<string>();
              for (const { writer } of ends) {
                const pending = pendingRecords(writer.doc, branchId);
                const { changes } = writer.view({ draft: branchId });
                const live = writer.view(LIVE);
                for (const record of pending) {
                  for (const source of changes.get(record.id)?.sources ?? []) out.add(source);
                  const node = live.nodes.get(record.node);
                  if (node) out.add(node.source);
                }
                for (const item of items) {
                  const node = live.nodes.get(item.node);
                  if (node) out.add(node.source);
                }
              }
              return out;
            },
          });
        };
        return await applyTiming.run({ commandId, measured: deps.measured }, () =>
          withTreeOwners(db, sources, (owners) =>
            runDocumentCommand(db, envelope, async (): Promise<ApplyClickResult> => {
              // The command awaits post-commit delivery too; stop the boundary clock at
              // root commit, before room recovery and document projections run.
              deferUntilDrizzleCommit(() => {
                committedAt = performance.now();
              });
              // The branch's owner enters the boundary after the claim, as Discard's does; the owners
              // of the notes the tree effect changes are locked with it.
              const answer = await deps.workProjection.mutate(
                { branches: [branchId], works: owners.works, lineages: owners.lineages },
                async (locked): Promise<ApplyClickResult> => {
                  // Orders this command with a Discard all's close; a closed branch has no pending
                  // records or open drafts, and each item below says what became of it.
                  await deps.branches.lockActive(branchId);
                  const judge = await owners.judge(locked);
                  const nodes = items.map((item) => item.node);
                  const listOf = await treeHalf.lockItems(nodes);
                  const draftOf = (item: PreparedApplyItem) =>
                    item.text?.base.snapshot.draftId ?? item.closedDraftId;
                  const settlements = await settlementOf(
                    db,
                    deps,
                    branchId,
                    items.map((item) => {
                      const draftId = draftOf(item);
                      return {
                        node: item.node,
                        list: listOf.get(item.node) ?? null,
                        ...(draftId ? { draftId } : {}),
                      };
                    }),
                    saw,
                  );
                  const settled = (node: string) => settlements.get(node) as ItemSettlement;
                  // A text half is open when its cut compiled and its draft is still the open row of
                  // this branch; otherwise its note is fixed now.
                  const textNote = new Map<string, Settlement>();
                  for (const item of items) {
                    const text = settled(item.node).text;
                    if (!text) continue;
                    if (item.text && text.open && text.branchId === branchId) continue;
                    textNote.set(
                      item.node,
                      text.open
                        ? { rule: "left_out", items: [item.node], why: "changed_since" }
                        : noteOf(text.last, item.node, "applied"),
                    );
                  }
                  const facts = await treeHalf.apply({
                    branchId,
                    userId,
                    commandId,
                    saw,
                    items: items.map((item) => ({
                      node: item.node,
                      list: listOf.get(item.node) ?? null,
                      tree: item.tree,
                      textOpen: Boolean(draftOf(item)) && !textNote.has(item.node),
                    })),
                    judge,
                  });
                  const fact = (node: string) => facts.get(node) as TreeItemFacts;
                  // The text half, in id order, every document's key held.
                  const texts = new Map<string, ApplyHalfResult>();
                  let overrode = 0;
                  for (const item of [...items].sort((a, b) => a.node.localeCompare(b.node))) {
                    if (!draftOf(item)) continue;
                    const note = textNote.get(item.node);
                    const one = fact(item.node);
                    if (one.textClosed) {
                      texts.set(item.node, {
                        landed: false,
                        settled: [fateNote(one.textClosed, item.node)],
                      });
                      continue;
                    }
                    if (note || !item.text) {
                      texts.set(item.node, {
                        landed: false,
                        settled: [
                          note ?? { rule: "left_out", items: [item.node], why: "changed_since" },
                        ],
                      });
                      continue;
                    }
                    // As the writer asked: the document this command deleted has nowhere for text.
                    if (one.deletedHere) {
                      texts.set(item.node, {
                        landed: false,
                        settled: [{ rule: "already", state: "removed", item: item.node }],
                      });
                      continue;
                    }
                    // Its create did not land: the text stays pending with the draft that holds it.
                    if (!one.standsInLive) {
                      texts.set(item.node, {
                        landed: false,
                        settled: [
                          closedNotes(one, judge, item.node)[0] ?? {
                            rule: "left_out",
                            items: [item.node],
                            why: "needs",
                          },
                        ],
                      });
                      continue;
                    }
                    // A whole cut found no text change on receipt: nothing of its text applies.
                    if (item.text.click.groups.length === 0) {
                      texts.set(item.node, {
                        landed: false,
                        settled: [{ rule: "already", state: "applied", item: item.node }],
                      });
                      continue;
                    }
                    const wrote = await applyText(command, item.node as DocumentId, item.text);
                    overrode += wrote.overrode;
                    texts.set(item.node, {
                      landed: true,
                      ...(one.restore
                        ? { settled: [{ rule: "restored", documentId: item.node }] }
                        : {}),
                      ...(wrote.at === undefined ? {} : { at: wrote.at }),
                    });
                  }

                  // A Redo's text half is the Undo of the Un-Apply it names.
                  const { redoOf } = command.request;
                  if (redoOf)
                    for (const one of await undoCommandText(db, deps, {
                      commandId,
                      undoes: redoOf,
                      accountId: userId,
                    }))
                      texts.set(one.documentId, {
                        landed: true,
                        ...(one.at ? { at: one.at } : {}),
                      });
                  const results = items.map((item): ApplyItemResult => {
                    const one = fact(item.node);
                    const text = texts.get(item.node);
                    return {
                      node: item.node,
                      // A restore is a tree fact of this command too: Un-Apply takes it back.
                      ...(one.ran || one.restore || (item.tree && !listOf.get(item.node))
                        ? {
                            tree: treeResult(item.node, one, settled(item.node).tree.last, judge),
                          }
                        : {}),
                      ...(text ? { text } : {}),
                    };
                  });
                  const applied = appliedOf(branchId, results);
                  if (applied.length === 0) {
                    const notes = results.flatMap((result) => [
                      ...(result.tree?.settled ?? []),
                      ...(result.text?.settled ?? []),
                    ]);
                    deferUntilDrizzleCommit(() =>
                      deps.answeredWithoutLanding({ commandId, settled: notes }),
                    );
                  }
                  return {
                    status: "applied",
                    commandId,
                    items: results,
                    applied,
                    ...(overrode ? { overrode } : {}),
                  };
                },
                { requireActive: false, seam: true },
              );
              if (answer.applied.length > 0) await treeHalf.recordCreatedHeads(commandId);
              return answer;
            }),
          ),
        );
      } finally {
        deps.measured({
          commandId,
          boundaryMs: (committedAt ?? performance.now()) - boundaryStart,
        });
      }
    },
  };
}
