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
  contentMerge,
  type RuleCounts,
  ruleCounter,
} from "@meridian/agent-edit/content-merge";
import {
  appendApplyRecord,
  baseViewDelta,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { InversePart, JournalSnapshot, UpdateJournal } from "@meridian/agent-edit/integration";
import { computeInverse } from "@meridian/agent-edit/integration";
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
import { appliedCreates, listRecords, undoApply } from "@meridian/project-tree";
import { allocateDocumentClient, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { approveBranchWriteJoin } from "../../../shared/branch-write-join.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
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
import type {
  BranchDocumentTree,
  BranchTreeStateReader,
} from "../domain/ports/branch-tree-state.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import { storedDocument } from "../domain/stored-document.js";
import {
  createApplyTreeOperations,
  type TreeItemFacts,
  textWrittenSince,
} from "./drizzle-apply-tree.js";
import { treeListOfNode, treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";
import { recordDocumentEdit, stampLiveEditsWithCommand } from "./drizzle-document-edits.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { type ReopenDrafts, reverseBaseHalf } from "./drizzle-reopen-drafts.js";
import {
  type ItemSettlement,
  noteOf,
  type Settled,
  settlementOf,
} from "./drizzle-settlement-of.js";
import { writeTextAnswer } from "./drizzle-text-answer.js";
import { loadPreparedUnapply, loadUnapplyHistory } from "./drizzle-unapply-read.js";

const applyTiming = new AsyncLocalStorage<{
  commandId: string;
  measured: (input: { commandId: string; holdMs: number }) => void;
}>();

/** Uses the append door's actual lock-to-root-commit time, not the server author's CPU time. */
export function measureApplyAppend(detail: { holdMs: number }): void {
  const timing = applyTiming.getStore();
  timing?.measured({ commandId: timing.commandId, holdMs: detail.holdMs });
}

/**
 * The tree half's answer from its record fates: landed when any of the item's records did, with a
 * `left_out` line per reason the rest stayed; with nothing pending, what settled the records.
 */
function treeResult(
  node: string,
  one: TreeItemFacts,
  last: Settled | null,
  wanted: BranchDocumentTree | undefined,
): NonNullable<ApplyItemResult["tree"]> {
  const left = new Set(one.left.map(({ record }) => record.id));
  const superseded = new Set(one.superseded.map((record) => record.id));
  const landed =
    one.restore !== null ||
    one.records.some((record) => !left.has(record.id) && !superseded.has(record.id));
  const notes: Settlement[] = [...new Set(one.left.map(({ why }) => why))].map((why) => ({
    rule: "left_out",
    items: [node],
    why,
  }));
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
    ...(wanted?.uri && to && wanted.uri !== to
      ? { renamed: { code: "renamed" as const, wanted: wanted.uri, path: to } }
      : {}),
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
        ...(tree?.landed && tree.renamed ? { renamed: tree.renamed } : {}),
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
    branchTree: BranchTreeStateReader;
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
      const liveEffects: { groupId: string; seq: number | null }[] = [];
      for (const group of click.groups) {
        const groupMerge = contentMerge(
          schema,
          group.before,
          readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
          group.patched,
        );
        overrode += groupMerge.overrode;
        addCounts(merged.fire, groupMerge.rules);
        update = undefined;
        live.transact(
          () =>
            writeBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, groupMerge.blocks),
          "apply",
        );
        const seq = update
          ? await deps.live.append(
              node,
              update,
              { seq: 0, origin: `human:${accountId}` },
              snapshot.authority,
            )
          : null;
        liveEffects.push({ groupId: group.groupId, seq });
      }
      deps.merged({ commandId, kind: "apply", rules: merged.counts, overrode });
      await stampLiveEditsWithCommand(
        tx,
        commandId,
        liveEffects.flatMap((effect) => (effect.seq === null ? [] : [effect.seq])),
      );
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
            liveUpdateSeq: liveEffect.seq,
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
        return await runDocumentCommand(db, command.envelope, () =>
          deps.workProjection.mutate(
            { branches: [prepared.branchId] },
            async (): Promise<UnapplyClickResult> => {
              const tx = currentDrizzleDb(db);
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
              await deps.treeLists.lock([...lists, ...trashedLists]);
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
              const left: { node: string; why: LeftOutWhy }[] = [];
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
                      for (const { record, why } of result.left)
                        if (why === "already") alreadyUndone.add(record.node);
                        else
                          left.push({ node: record.node, why: why === "unknown" ? "purged" : why });
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
                inverse: ReturnType<typeof computeInverse>;
                reversed: PreparedUnapply["texts"][number]["effects"];
                skipped: PreparedUnapply["texts"][number]["effects"];
              }[] = [];
              for (const text of prepared.texts) {
                const [draft] = await tx
                  .select({ status: documentDrafts.status })
                  .from(documentDrafts)
                  .where(eq(documentDrafts.id, text.draftId));
                const currentBase =
                  draft?.status === "active" ? await deps.coordinator.loadBase(text.draftId) : null;
                const effects = text.effects.filter((effect) => activeOrdinals.has(effect.ordinal));
                if (!effects.length) continue;
                const snapshot = await deps.live.read(text.documentId);
                const live = storedDocument(snapshot);
                lives.push(live);
                const history = await loadUnapplyHistory(
                  db,
                  text.documentId,
                  effects.flatMap((effect) =>
                    effect.liveUpdateSeq === null ? [] : [effect.liveUpdateSeq],
                  ),
                );
                const bySeq = new Map<number, InversePart>();
                for (const part of history) {
                  const value = part.origin;
                  if (value?.kind === "live") bySeq.set(value.seq, part);
                }
                const targeted = effects.flatMap((effect) => {
                  if (effect.liveUpdateSeq === null) return [];
                  const part = bySeq.get(effect.liveUpdateSeq);
                  return part ? [{ effect, part }] : [];
                });
                const inverse = computeInverse(
                  live,
                  history,
                  // Latest group first: a group's live update builds on the earlier groups' items, so the
                  // earlier group is intact only once the later one is out.
                  [...targeted].reverse().map(({ part }) => part),
                  { actionId: commandId, allocateClient: allocateDocumentClient },
                );
                const reversedEditIds = new Set(inverse.edits.map((edit) => edit.targetEditId));
                const reversed = effects.filter(
                  (effect) =>
                    effect.liveUpdateSeq === null ||
                    targeted.some(
                      ({ effect: candidate, part }) =>
                        candidate.ordinal === effect.ordinal && reversedEditIds.has(part.editId),
                    ),
                );
                plans.push({
                  documentId: text.documentId,
                  currentBase,
                  draftGone: !draft,
                  snapshot,
                  live,
                  inverse,
                  reversed,
                  skipped: effects.filter((effect) => !reversed.includes(effect)),
                });
              }
              let unappliedSeq: string | undefined;
              for (const plan of plans) {
                if (!plan.reversed.length) continue;
                const { documentId, live, snapshot, inverse, currentBase } = plan;
                const receipts: Parameters<typeof recordDocumentEdit>[1]["receipts"] = [];
                for (const edit of inverse.edits) {
                  for (const part of edit.parts) {
                    const provenance = captureMutationUpdates(live, () => {
                      live.transact(() => {
                        Y.applyUpdate(live, part.update);
                        appendInverseRestorationFacts(live, part.aliases);
                      });
                    });
                    const update = provenance.length
                      ? Y.mergeUpdates([part.update, ...provenance])
                      : part.update;
                    const seq = await deps.live.append(
                      documentId,
                      update,
                      { seq: 0, origin: "system" },
                      snapshot.authority,
                    );
                    receipts.push({ ...part, update, origin: { kind: "live", seq } });
                  }
                }
                if (receipts.length)
                  await recordDocumentEdit(tx, {
                    documentId,
                    actor: "human",
                    actorUserId: command.envelope.accountId,
                    kind: "undo",
                    actionId: commandId,
                    commandId,
                    receipts,
                  });

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
                          merges: plan.reversed.filter((effect) => effect.liveUpdateSeq !== null),
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
              const reversedGroupIds = plans.flatMap((plan) =>
                plan.reversed.map((effect) => effect.groupId),
              );
              const skippedGroupIds = plans.flatMap((plan) =>
                plan.skipped.map((effect) => effect.groupId),
              );
              const settled: Settlement[] = [];
              const byWhy = new Map<LeftOutWhy, Set<string>>();
              for (const { node, why } of left)
                byWhy.set(why, (byWhy.get(why) ?? new Set()).add(node));
              // The Work's purge took the rows that said what the tree half was.
              if (prepared.treeLost.length)
                byWhy.set(
                  "purged",
                  new Set([...(byWhy.get("purged") ?? []), ...prepared.treeLost]),
                );
              for (const [why, nodes] of byWhy)
                settled.push({ rule: "left_out", items: [...nodes], why });
              for (const node of alreadyUndone)
                settled.push({ rule: "already", state: "unapplied", item: node });
              // Everything this Apply did was taken back before, or it left nothing to take back.
              if (
                settled.length === 0 &&
                treeUndone.size === 0 &&
                reversedGroupIds.length === 0 &&
                skippedGroupIds.length === 0
              )
                settled.push({ rule: "already", state: "unapplied" });
              return {
                status: "unapplied",
                commandId,
                branchId: (target ? target.id : prepared.branchId) as BranchId,
                draftHalfWaits: plans.some(
                  (plan) => plan.reversed.length > 0 && !plan.currentBase && !plan.draftGone,
                ),
                reversedGroupIds,
                skippedGroupIds,
                treeUndone: [...treeUndone],
                ...(settled.length ? { settled } : {}),
              };
            },
            { requireActive: false, seam: true },
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
        return await applyTiming.run({ commandId, measured: deps.measured }, () =>
          runDocumentCommand(db, envelope, async (): Promise<ApplyClickResult> => {
            // The command awaits post-commit delivery too; stop the boundary clock at
            // root commit, before room recovery and document projections run.
            deferUntilDrizzleCommit(() => {
              committedAt = performance.now();
            });
            // The branch's owner enters the boundary after the claim, as Discard's does.
            const answer = await deps.workProjection.mutate(
              { branches: [branchId] },
              async (): Promise<ApplyClickResult> => {
                // Orders this command with a Discard all's close; a closed branch has no pending
                // records or open drafts, and each item below says what became of it.
                await deps.branches.lockActive(branchId);
                const nodes = items.map((item) => item.node);
                // Read before the locks, for the `renamed` note's wanted path only: nothing in it
                // decides a write.
                const wanted = new Map(
                  (await deps.branchTree.read(branchId, [], nodes as DocumentId[])).map((item) => [
                    item.documentId as string,
                    item,
                  ]),
                );
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
                      settled: [{ rule: "left_out", items: [item.node], why: "needs" }],
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
                    // A restore is a tree fact of this command too: Un-Apply takes it back, and a
                    // name taken meanwhile gives the document a new path to report.
                    ...(one.ran || one.restore || (item.tree && !listOf.get(item.node))
                      ? {
                          tree: treeResult(
                            item.node,
                            one,
                            settled(item.node).tree.last,
                            wanted.get(item.node),
                          ),
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
