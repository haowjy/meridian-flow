/**
 * Atomic Apply: Work lock, command claim, committed live effect and prefix-authored base.
 * One executor for any selection of nodes, folders included. Under the Work, branch, list and
 * document keys it reads what settled each item (`settlementOf`), lands the tree cuts in the
 * lists that hold the drafted records (`drizzle-apply-tree.ts`), then merges each document's
 * text at the result. Each half of an item is answered on its own evidence: the text lands
 * wherever its draft is open and its document stands in live, whatever the tree half did. The
 * command keeps both halves (`apply_command_trees`, `apply_command_effects`), and Un-Apply takes
 * back all of it, across every document.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  addCounts,
  applyBase,
  captureDelta,
  changeStateIn,
  contentMerge,
  type RuleCounts,
  readDelta,
  ruleCounter,
  type StoredDelta,
  takeOut,
} from "@meridian/agent-edit/content-merge";
import {
  appendApplyRecord,
  baseViewDelta,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { JournalSnapshot, UpdateJournal } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { type BranchId, type DocumentId, draftItemKey, type UserId } from "@meridian/contracts";
import type {
  AppliedReviewItem,
  ApplyClickResult,
  ApplyHalfResult,
  ApplyItemResult,
  UnapplyClickResult,
} from "@meridian/contracts/branches";
import type { LeftOutWhy, Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import {
  applyCommandEffects,
  branches,
  documentDrafts,
  treeNodes,
} from "@meridian/database/schema";
import {
  appliedCreates,
  LIVE,
  listRecords,
  madeBy,
  pendingRecords,
  type TreeWriter,
  undoApply,
} from "@meridian/project-tree";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import {
  type ClosedSource,
  returnedFor,
  type SourceFate,
  type TreeJudge,
  withTreeOwners,
} from "../../../shared/tree-owners.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";
import type { TreeReader } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type {
  ApplyCommand,
  ApplyCommandStore,
  PreparedApplyItem,
  PreparedUnapply,
} from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { DraftBase } from "../domain/draft-runtime.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { storedDocument } from "../domain/stored-document.js";
import {
  createApplyTreeOperations,
  type TreeItemFacts,
  textWrittenSince,
} from "./drizzle-apply-tree.js";
import { treeListOfNode, treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { type ReopenDrafts, reverseBaseHalf } from "./drizzle-reopen-drafts.js";
import {
  type ItemSettlement,
  noteOf,
  type Settled,
  settlementOf,
} from "./drizzle-settlement-of.js";
import { writeTextAnswer } from "./drizzle-text-answer.js";
import { loadPreparedUnapply } from "./drizzle-unapply-read.js";

const documentSchema = buildDocumentSchema();

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
    reopen: ReopenDrafts;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    arrivals?: Pick<DocumentArrivals, "settle">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit" | "resync">;
    tree: Pick<TreeReader, "identityStatus">;
    close: Pick<DraftClose, "closeDrafts">;
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
   * and each is recorded as an effect (`ordinal` counts on from `ordinalFrom`, across the
   * command's documents). The caller holds the document's key.
   */
  async function applyText(
    command: ApplyCommand,
    node: DocumentId,
    { base, click }: NonNullable<PreparedApplyItem["text"]>,
    ordinalFrom: number,
  ): Promise<{ overrode: number }> {
    const tx = currentDrizzleDb(db);
    const { commandId, accountId } = command.envelope;
    const { schema } = click;
    const snapshot = await deps.live.read(node);
    const live = storedDocument(snapshot);
    let update: Uint8Array | undefined;
    const capture = (bytes: Uint8Array) => {
      update = bytes;
    };
    live.on("update", capture);
    try {
      let overrode = 0;
      const merged = ruleCounter();
      const liveEffects: { groupId: string; delta: StoredDelta | null }[] = [];
      const fragment = live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      for (const group of click.groups) {
        const before = readBlocks(fragment, schema);
        const groupMerge = contentMerge(schema, group.before, before, group.patched);
        overrode += groupMerge.overrode;
        addCounts(merged.fire, groupMerge.rules);
        update = undefined;
        live.transact(() => writeBlocks(fragment, schema, groupMerge.blocks), "apply");
        if (update)
          await deps.live.append(
            node,
            update,
            { seq: 0, origin: `human:${accountId}` },
            snapshot.authority,
          );
        liveEffects.push({
          groupId: group.groupId,
          delta: update ? captureDelta(before, readBlocks(fragment, schema)) : null,
        });
      }
      deps.merged({ commandId, kind: "apply", rules: merged.counts, overrode });
      await testHook("apply.afterLive");
      const baseEffects: { groupId: string; start?: unknown[]; delta: unknown[] }[] = [];
      const write = deps.coordinator.prepareAppend(base, [], {
        work: "any",
        authorServerRows(prefix) {
          const rows: Uint8Array[] = [];
          let row: Uint8Array | undefined;
          const capture = (bytes: Uint8Array) => {
            row = bytes;
          };
          prefix.on("update", capture);
          try {
            for (const group of click.groups) {
              row = undefined;
              const fragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
              const before = readBlocks(fragment, schema);
              const after = applyBase(schema, before, group.before, group.patched);
              prefix.transact(() => {
                writeBlocks(fragment, schema, after);
                appendApplyRecord(prefix, group.record);
              }, "apply");
              if (!row) throw new Error("Apply must append its command record");
              rows.push(row);
              baseEffects.push({
                groupId: group.groupId,
                ...(baseEffects.length === 0
                  ? { start: before.map((block) => block.toJSON()) }
                  : {}),
                delta: baseViewDelta(schema, before, after).map((patch) => ({
                  ...patch,
                  blocks: patch.blocks.map((block) => block.toJSON()),
                })),
              });
            }
            return rows;
          } finally {
            prefix.off("update", capture);
          }
        },
      });
      try {
        await write.persist();
        write.transfer();
      } finally {
        write.dispose();
      }
      await tx.insert(applyCommandEffects).values(
        click.groups.map((group, at) => {
          const liveEffect = liveEffects.find((effect) => effect.groupId === group.groupId);
          const baseEffect = baseEffects.find((effect) => effect.groupId === group.groupId);
          if (!liveEffect || !baseEffect) throw new Error("Apply effect was not captured");
          return {
            commandId,
            ordinal: ordinalFrom + at,
            groupId: group.groupId,
            documentId: node,
            draftId: base.snapshot.draftId,
            liveDelta: liveEffect.delta,
            carried: group.carried,
            baseStart: baseEffect.start,
            baseDelta: baseEffect.delta,
          };
        }),
      );
      deferUntilDrizzleCommit(async () => {
        await deps.liveCoordinator.deliver(node);
        await deps.onCommitted(node);
      });
      return { overrode };
    } finally {
      live.off("update", capture);
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
            eq(documentDrafts.status, "active"),
            eq(branches.id, branchId),
            eq(branches.status, "active"),
          ),
        );
      if (!identity) return null;
      try {
        return await deps.coordinator.loadBase(draftId);
      } catch (cause) {
        // A discarded creation closes its drafts between resolution and this read.
        const [row] = await currentDrizzleDb(db)
          .select({ status: documentDrafts.status })
          .from(documentDrafts)
          .where(eq(documentDrafts.id, draftId));
        if (!row || row.status === "closed") return null;
        throw cause;
      }
    },
    loadUnapply: (command) => loadPreparedUnapply(db, command),
    async unapply(command, found) {
      // Nothing left to take back: the command still runs, so a resend finds its answer.
      const prepared = found ?? { branchId: command.branchId, texts: [], trees: [], treeLost: [] };
      const commandId = command.envelope.commandId;
      const applyCommandId = command.request.applyCommandId;
      const by = `user:${command.envelope.accountId}`;
      const lives: Y.Doc[] = [];
      try {
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
                // What stays as the Apply left it, because taking it back would change a closed
                // owner's notes, per node.
                const held = new Map<
                  string,
                  { owner: ClosedSource; tree: boolean; groupIds: string[] }
                >();
                const hold = (node: string, owner: ClosedSource) => {
                  const entry = held.get(node) ?? { owner, tree: false, groupIds: [] };
                  held.set(node, entry);
                  return entry;
                };
                // The drafts this Apply's delete closed come back before anything reads a base
                // (`reopenDrafts`). The Work's current branch is made only for them: an Un-Apply
                // with nothing to reopen must not create one.
                const closedByApply = await deps.reopen.closedBy(applyCommandId, prepared.branchId);
                const found = closedByApply.length
                  ? await deps.branches.ownerOf(prepared.branchId)
                  : null;
                // Only the Work is locked so far, as `ensureActiveForWrite` requires.
                if (found?.owner) approveBranchWriteJoin();
                const target =
                  found?.owner &&
                  (await deps.branches.ensureActiveForWrite(
                    {
                      owner: found.owner,
                      projectId: command.envelope.projectId,
                      threadId: null,
                      userId: command.envelope.accountId as UserId,
                    },
                    { requireActive: false },
                  ));
                // A closed branch still lets the tree half land; the lock only orders it with a Discard's close.
                if (!target) await deps.branches.lockActive(prepared.branchId);
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
                for (const draft of closedByApply) documentIds.add(draft.documentId);
                for (const id of [...documentIds].sort())
                  await lockDocumentMutation(tx, id as DocumentId);
                const backFromDelete = new Set<string>();
                const left: { node: string; why: LeftOutWhy; tree: boolean }[] = [];
                const treeUndone = new Set<string>();
                const alreadyUndone = new Set<string>();
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
                        const records = new Map(
                          listRecords(writer.doc).map((record) => [record.id, record]),
                        );
                        for (const record of result.undone) {
                          treeUndone.add(record.node);
                          if (record.type !== "restore") continue;
                          // A delete taken back puts every document it covered where it was before
                          // the Apply, a folder's cascade included.
                          const taken = record.undoes ? records.get(record.undoes) : undefined;
                          for (const node of [
                            record.node,
                            ...(taken?.type === "delete" ? taken.cascade : []),
                          ])
                            backFromDelete.add(node);
                        }
                        // A change something else already took back (a card's Undo) is `already`,
                        // not a loss.
                        for (const { record, why, source } of result.left)
                          if (why === "closed") {
                            const fate = source === undefined ? null : judge.fate(source);
                            if (fate?.kind === "closed") hold(record.node, fate).tree = true;
                            else left.push({ node: record.node, why: "purged", tree: true });
                          } else if (why === "already") alreadyUndone.add(record.node);
                          else
                            left.push({
                              node: record.node,
                              why: why === "unknown" ? "purged" : why,
                              tree: true,
                            });
                      }
                    },
                  });
                }
                // Only a draft whose closing delete the tree half took back reopens: a document the
                // writer restored by hand and deleted again stays in Trash with its draft closed.
                if (target && found?.owner)
                  await deps.reopen.reopen({
                    drafts: closedByApply.filter((draft) => backFromDelete.has(draft.documentId)),
                    target: target.id,
                    commandId,
                    owner: found.owner,
                  });

                // What each document's text would give back, read before any text is written.
                const stillActive = await tx
                  .select({ ordinal: applyCommandEffects.ordinal })
                  .from(applyCommandEffects)
                  .where(
                    and(
                      eq(applyCommandEffects.commandId, applyCommandId),
                      isNull(applyCommandEffects.unappliedBy),
                    ),
                  );
                const activeOrdinals = new Set(stillActive.map((row) => row.ordinal));
                const plans: {
                  documentId: DocumentId;
                  /** Null: the draft is closed (its Un-Apply waits for a reopen) or purged. */
                  currentBase: DraftBase | null;
                  draftGone: boolean;
                  snapshot: JournalSnapshot;
                  live: Y.Doc;
                  /** Live's blocks once the reversed groups are out. */
                  blocks: readonly PMNode[];
                  reversed: PreparedUnapply["texts"][number]["effects"];
                  skipped: PreparedUnapply["texts"][number]["effects"];
                }[] = [];
                // A document in notes that take no change keeps its text as the Apply left it. Only an
                // effect still applied can be held, and where the document stands is read after the
                // tree half, which may have moved it.
                const stands = prepared.texts.length
                  ? await deps.treeLists.read({ lists: branchLists, view: placesOfTexts })
                  : new Map<string, string>();
                const textFates = new Map<string, SourceFate>();
                for (const text of prepared.texts) {
                  if (!text.effects.some((effect) => activeOrdinals.has(effect.ordinal))) continue;
                  const source = stands.get(text.documentId);
                  const fate = source === undefined ? null : judge.fate(source);
                  if (fate) textFates.set(text.documentId, fate);
                }
                judge.assertLocked();
                for (const text of prepared.texts) {
                  const effects = text.effects.filter((effect) =>
                    activeOrdinals.has(effect.ordinal),
                  );
                  if (!effects.length) continue;
                  const fate = textFates.get(text.documentId);
                  if (fate?.kind === "closed") {
                    hold(text.documentId, fate).groupIds.push(
                      ...effects.map((effect) => effect.groupId),
                    );
                    continue;
                  }
                  // Its row was purged with its Work, and the document's effects went with it.
                  if (fate) {
                    left.push({ node: text.documentId, why: "purged", tree: false });
                    continue;
                  }
                  const [draft] = await tx
                    .select({ status: documentDrafts.status })
                    .from(documentDrafts)
                    .where(eq(documentDrafts.id, text.draftId));
                  const currentBase =
                    draft?.status === "active"
                      ? await deps.coordinator.loadBase(text.draftId)
                      : null;
                  const snapshot = await deps.live.read(text.documentId);
                  const live = storedDocument(snapshot);
                  lives.push(live);
                  // The latest group first: a group's change builds on the earlier groups', so the
                  // earlier one comes out cleanly only once the later one is out. Each is judged
                  // on what the ones before it leave. A group that changed nothing in live has
                  // nothing to take out and reverses.
                  let blocks: readonly PMNode[] = readBlocks(
                    live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
                    documentSchema,
                  );
                  const taken = new Set<number>();
                  for (const effect of [...effects].reverse()) {
                    if (!effect.liveDelta) {
                      taken.add(effect.ordinal);
                      continue;
                    }
                    const change = readDelta(documentSchema, effect.liveDelta);
                    if (changeStateIn(documentSchema, change, blocks) !== "stands") continue;
                    blocks = takeOut(documentSchema, change, blocks);
                    taken.add(effect.ordinal);
                  }
                  const reversed = effects.filter((effect) => taken.has(effect.ordinal));
                  plans.push({
                    documentId: text.documentId,
                    currentBase,
                    draftGone: !draft,
                    snapshot,
                    live,
                    blocks,
                    reversed,
                    skipped: effects.filter((effect) => !reversed.includes(effect)),
                  });
                }
                let unappliedSeq: string | undefined;
                for (const plan of plans) {
                  if (!plan.reversed.length) continue;
                  const { documentId, live, snapshot, blocks, currentBase } = plan;
                  const fragment = live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
                  const written = captureMutationUpdates(live, () =>
                    live.transact(() => writeBlocks(fragment, documentSchema, blocks), "unapply"),
                  );
                  for (const update of written)
                    await deps.live.append(
                      documentId,
                      update,
                      { seq: 0, origin: "system" },
                      snapshot.authority,
                    );

                  if (currentBase) {
                    const groupIds = new Set(plan.reversed.map((effect) => effect.groupId));
                    let reversal: ReturnType<typeof reverseBaseHalf> | undefined;
                    const write = deps.coordinator.prepareAppend(currentBase, [], {
                      work: "any",
                      authorServerRows(prefix) {
                        reversal = reverseBaseHalf(prefix, [
                          {
                            applyCommandId,
                            groupIds,
                            merges: plan.reversed.filter((effect) => effect.liveDelta !== null),
                          },
                        ]);
                        return reversal.rows;
                      },
                    });
                    try {
                      await write.persist();
                      write.transfer();
                    } finally {
                      write.dispose();
                    }
                    // The take-back puts the draft's text back, so its row is right at this commit.
                    // Its watermark stays stale: the projection judges it again.
                    await writeTextAnswer(db, deps.treeLists, {
                      draftId: currentBase.snapshot.draftId,
                      hasEffect: true,
                      hasEffectRevision: -1,
                      listsHeld: true,
                    });
                    deps.merged({
                      commandId,
                      kind: "unapply",
                      rules: reversal?.rules ?? {},
                      overrode: reversal?.overrode ?? 0,
                    });
                  }
                  unappliedSeq ??= (
                    await tx.execute<{ seq: string }>(
                      sql`select nextval('apply_command_effects_unapplied_seq')::text as seq`,
                    )
                  )[0]?.seq;
                  await tx
                    .update(applyCommandEffects)
                    .set({
                      unappliedBy: commandId,
                      unappliedSeq: Number(unappliedSeq),
                      // A closed draft's half waits for its reopen (`reopenDrafts`).
                      draftReversed: currentBase !== null || plan.draftGone,
                    })
                    .where(
                      and(
                        eq(applyCommandEffects.commandId, applyCommandId),
                        inArray(
                          applyCommandEffects.ordinal,
                          plan.reversed.map((effect) => effect.ordinal),
                        ),
                        isNull(applyCommandEffects.unappliedBy),
                      ),
                    );
                  deferUntilDrizzleCommit(async () => {
                    await deps.liveCoordinator.deliver(documentId);
                    await deps.onCommitted(documentId);
                  });
                }
                // One change made in two documents has one group id: each is named with its document.
                const textOf = (pick: (plan: (typeof plans)[number]) => { groupId: string }[]) =>
                  plans.flatMap((plan) => {
                    const groupIds = [...new Set(pick(plan).map((effect) => effect.groupId))];
                    return groupIds.length ? [{ node: plan.documentId, groupIds }] : [];
                  });
                const textUndone = textOf((plan) => plan.reversed);
                const textSkipped = textOf((plan) => plan.skipped);
                // A skipped group holds writing made since, judged on this press: a later one may
                // find its words back (another Undo restored them) and take it.
                for (const plan of plans)
                  if (plan.skipped.length)
                    left.push({ node: plan.documentId, why: "changed_since", tree: false });
                // The Work's purge took the rows that said what the tree half was.
                for (const node of prepared.treeLost)
                  left.push({ node, why: "purged", tree: true });
                const settled: Settlement[] = [];
                const lines = new Map<
                  string,
                  { why: LeftOutWhy; tree: boolean; items: Set<string> }
                >();
                for (const { node, why, tree } of left) {
                  const key = `${tree}:${why}`;
                  const line = lines.get(key) ?? { why, tree, items: new Set<string>() };
                  line.items.add(node);
                  lines.set(key, line);
                }
                for (const { why, tree, items } of lines.values())
                  settled.push({ rule: "left_out", items: [...items], why, tree });
                for (const node of alreadyUndone)
                  settled.push({ rule: "already", state: "unapplied", item: node });
                // One `returned` line per owner and reason, naming the nodes it held.
                const returned = new Map<string, { owner: ClosedSource; nodes: string[] }>();
                for (const [node, { owner }] of held) {
                  const key = `${owner.why}:${owner.ownerKey}`;
                  const line = returned.get(key) ?? { owner, nodes: [] };
                  line.nodes.push(node);
                  returned.set(key, line);
                }
                for (const { owner, nodes } of returned.values())
                  settled.push(returnedFor(owner, nodes));
                // Everything this Apply did was taken back before: nothing taken, left or held now.
                if (settled.length === 0 && treeUndone.size === 0 && textUndone.length === 0)
                  settled.push({ rule: "already", state: "unapplied" });
                return {
                  status: "unapplied",
                  commandId,
                  branchId: (target ? target.id : prepared.branchId) as BranchId,
                  draftHalfWaits: plans.some(
                    (plan) => plan.reversed.length > 0 && !plan.currentBase && !plan.draftGone,
                  ),
                  textUndone,
                  textSkipped,
                  treeUndone: [...treeUndone],
                  held: [...held].map(([node, { owner, tree, groupIds }]) => ({
                    node,
                    tree,
                    groupIds,
                    why: owner.why,
                    ownerKey: owner.ownerKey,
                  })),
                  ...(settled.length ? { settled } : {}),
                };
              },
              { requireActive: false, seam: true },
            ),
          ),
        );
      } finally {
        for (const live of lives) live.destroy();
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
                  const deleted = items.flatMap((item) =>
                    fact(item.node).deletedHere ? [item.node as DocumentId] : [],
                  );
                  // Only a delete this command committed closes a draft, under its id. Their live
                  // rooms stay open: a document in Trash still takes text until it is purged.
                  if (deleted.length > 0)
                    await deps.close.closeDrafts(
                      currentDrizzleDb(db),
                      { documentIds: deleted, branchId },
                      "document_discarded",
                      commandId,
                    );

                  // The text half, in id order, every document's key held.
                  const texts = new Map<string, ApplyHalfResult>();
                  let ordinal = 0;
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
                    const wrote = await applyText(
                      command,
                      item.node as DocumentId,
                      item.text,
                      ordinal,
                    );
                    ordinal += item.text.click.groups.length;
                    overrode += wrote.overrode;
                    texts.set(
                      item.node,
                      one.restore
                        ? { landed: true, settled: [{ rule: "restored", documentId: item.node }] }
                        : { landed: true },
                    );
                  }

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
