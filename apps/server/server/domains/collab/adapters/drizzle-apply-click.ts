/**
 * Atomic Apply: Work lock, command claim, committed live effect and prefix-authored base.
 * One executor for any selection of nodes, folders included: the tree cuts run first, in the
 * lists that hold the drafted records: the package's `applyDraft` appends live copies and settles
 * the drafted ones, in this transaction (`drizzle-apply-tree.ts`); then each document's text
 * merges at the result. A document live has in Trash comes back only when the click carries the
 * writer's `restore`. The command keeps both halves (`apply_command_trees`,
 * `apply_command_effects`), and Un-Apply takes back all of it, across every document.
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
  removeApplyRecords,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { InversePart, JournalSnapshot, UpdateJournal } from "@meridian/agent-edit/integration";
import { computeInverse } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { type DocumentId, draftItemKey, type UserId } from "@meridian/contracts";
import type { ApplyClickResult, UnapplyClickResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { applyCommandEffects, branches, documentDrafts } from "@meridian/database/schema";
import { appliedCreates, undoApply } from "@meridian/project-tree";
import {
  allocateDocumentClient,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { type TreeListStore, TreeRefusal } from "../../context/ports/tree-list-store.js";
import type { TreeReader } from "../../context/tree/tree-view.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import {
  ApplyClickRefused,
  type ApplyCommand,
  type ApplyCommandStore,
  type PreparedApplyItem,
  type PreparedUnapply,
} from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import type { DraftBase } from "../domain/draft-runtime.js";
import { DraftStaleUpdateError } from "../domain/draft-store.js";
import type { BranchTreeStateReader } from "../domain/ports/branch-tree-state.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import { storedDocument } from "../domain/stored-document.js";
import { createApplyTreeOperations, textWrittenSince } from "./drizzle-apply-tree.js";
import { treeListsOfBranch } from "./drizzle-branch-tree-lists.js";
import { branchRowRevisions } from "./drizzle-branch-tree-state.js";
import { runCommand } from "./drizzle-document-commands.js";
import { recordDocumentEdit, stampLiveEditsWithCommand } from "./drizzle-document-edits.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { loadPreparedUnapply, loadUnapplyHistory } from "./drizzle-unapply-read.js";
import { asLifecycleRefusal } from "./lifecycle-refusal.js";

const applyTiming = new AsyncLocalStorage<{
  commandId: string;
  measured: (input: { commandId: string; holdMs: number }) => void;
}>();
const schema = buildDocumentSchema();

/** Uses the append door's actual lock-to-root-commit time, not the server author's CPU time. */
export function measureApplyAppend(detail: { holdMs: number }): void {
  const timing = applyTiming.getStore();
  timing?.measured({ commandId: timing.commandId, holdMs: detail.holdMs });
}

export function createDrizzleApplyClick(
  db: Database,
  deps: {
    workProjection: WorkProjectionMutation;
    branches: Pick<Branches, "lockActive">;
    coordinator: Pick<DraftCoordinator, "loadBase" | "prepareAppend">;
    live: UpdateJournal;
    liveCoordinator: Pick<LiveDocumentCoordinator, "deliver">;
    arrivals?: Pick<DocumentArrivals, "settle">;
    treeLists: Pick<TreeListStore, "lock" | "read" | "submit">;
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
  },
): ApplyCommandStore {
  const treeHalf = createApplyTreeOperations({
    db,
    treeLists: deps.treeLists,
    tree: deps.tree,
    close: deps.close,
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
    loadUnapply: (command) => loadPreparedUnapply(db, deps.coordinator, command),
    async unapply(command, prepared) {
      const commandId = command.envelope.commandId;
      const applyCommandId = command.request.applyCommandId;
      const by = `user:${command.envelope.accountId}`;
      const closed = (): UnapplyClickResult => ({ status: "closed", commandId });
      const unapplyRefusal = (cause: unknown): UnapplyClickResult | undefined =>
        cause instanceof TreeRefusal
          ? { status: "refused", commandId, reason: cause.reason }
          : cause instanceof ApplyClickRefused
            ? { status: "refused", commandId }
            : cause instanceof DraftStaleUpdateError
              ? closed()
              : undefined;
      const lives: Y.Doc[] = [];
      try {
        return await runCommand(
          db,
          command.envelope,
          () =>
            deps.workProjection.mutate(
              { branches: [prepared.branchId] },
              async (): Promise<UnapplyClickResult> => {
                const tx = currentDrizzleDb(db);
                if (!(await deps.branches.lockActive(prepared.branchId))) return closed();
                // The lists' keys, then the documents': the text of every document the Apply
                // created is asked about, and the tree rows are written, under both.
                const pairs = (await treeListsOfBranch(db, prepared.branchId)).flatMap((list) => {
                  const tree = prepared.trees.find((candidate) => candidate.scope === list.kind);
                  return tree ? [{ list, tree }] : [];
                });
                const lists = pairs.map(({ list }) => list);
                await deps.treeLists.lock(lists);
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

                // What each document's text would give back, read before anything is written:
                // the tree half can still refuse the whole command.
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
                  currentBase: DraftBase;
                  snapshot: JournalSnapshot;
                  live: Y.Doc;
                  inverse: ReturnType<typeof computeInverse>;
                  reversed: PreparedUnapply["texts"][number]["effects"];
                  skipped: PreparedUnapply["texts"][number]["effects"];
                }[] = [];
                for (const text of prepared.texts) {
                  const currentBase = await deps.coordinator.loadBase(text.base.snapshot.draftId);
                  if (
                    currentBase.snapshot.status === "closed" ||
                    currentBase.snapshot.documentId !== text.documentId ||
                    currentBase.snapshot.branchId !== prepared.branchId
                  )
                    return closed();
                  const effects = text.effects.filter((effect) =>
                    activeOrdinals.has(effect.ordinal),
                  );
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
                    [...targeted]
                      .reverse()
                      .map(({ part }) => ({ part, direction: "invert" as const })),
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
                    snapshot,
                    live,
                    inverse,
                    reversed,
                    skipped: effects.filter((effect) => !reversed.includes(effect)),
                  });
                }
                // Text recorded and none of it left to take back: an earlier Un-Apply took it.
                if (prepared.texts.length > 0 && plans.length === 0)
                  return { status: "refused", commandId };

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
                        const outcome = undoApply(
                          writer,
                          applyCommandId,
                          tree.mark,
                          by,
                          commandId,
                          written,
                          tree.restored,
                        );
                        if (outcome !== "undone") throw new TreeRefusal(outcome);
                      }
                    },
                  });
                }

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

                  const groupIds = new Set(plan.reversed.map((effect) => effect.groupId));
                  const reversedWithLive = plan.reversed.filter(
                    (effect) => effect.liveUpdateSeq !== null,
                  );
                  let unapplyMerged = { rules: {} as RuleCounts, overrode: 0 };
                  const write = deps.coordinator.prepareAppend(currentBase, [], {
                    authorServerRows(prefix) {
                      let row: Uint8Array | undefined;
                      const capture = (bytes: Uint8Array) => {
                        row = bytes;
                      };
                      prefix.on("update", capture);
                      try {
                        prefix.transact(() => {
                          const fragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
                          let current = readBlocks(fragment, schema);
                          const total = ruleCounter();
                          let overrode = 0;
                          for (const effect of [...reversedWithLive].reverse()) {
                            const merge = contentMerge(
                              schema,
                              effect.baseAfter.map((node) => schema.nodeFromJSON(node)),
                              current,
                              effect.baseBefore.map((node) => schema.nodeFromJSON(node)),
                            );
                            addCounts(total.fire, merge.rules);
                            overrode += merge.overrode;
                            current = merge.blocks;
                          }
                          unapplyMerged = { rules: total.counts, overrode };
                          writeBlocks(fragment, schema, current);
                          removeApplyRecords(prefix, applyCommandId, groupIds);
                        }, "unapply");
                        if (!row) throw new Error("Un-Apply must remove its Apply records");
                        return [row];
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
                  deps.merged({ commandId, kind: "unapply", ...unapplyMerged });
                  await tx
                    .update(applyCommandEffects)
                    .set({ unappliedBy: commandId })
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
                return {
                  status: "unapplied",
                  commandId,
                  reversedGroupIds: plans.flatMap((plan) =>
                    plan.reversed.map((effect) => effect.groupId),
                  ),
                  skippedGroupIds: plans.flatMap((plan) =>
                    plan.skipped.map((effect) => effect.groupId),
                  ),
                };
              },
              { requireActive: true, seam: true },
            ),
          unapplyRefusal,
        );
      } catch (cause) {
        throw asLifecycleRefusal(cause);
      } finally {
        for (const live of lives) live.destroy();
      }
    },
    measured: deps.measured,
    async apply(command, items) {
      const { branchId, request, envelope } = command;
      const { commandId } = envelope;
      const userId = envelope.accountId as UserId;
      const closed = (): ApplyClickResult => ({ status: "closed", commandId });
      const applyRefusal = (cause: unknown): ApplyClickResult | undefined =>
        cause instanceof ApplyClickRefused
          ? { status: "refused", commandId, reason: cause.reason }
          : cause instanceof DraftStaleUpdateError
            ? closed()
            : undefined;
      await testHook("apply.beforeBoundary");
      const boundaryStart = performance.now();
      let committedAt: number | undefined;
      try {
        return await applyTiming.run({ commandId, measured: deps.measured }, () =>
          runCommand(
            db,
            envelope,
            async (): Promise<ApplyClickResult> => {
              // The command awaits post-commit delivery too; stop the boundary clock at
              // root commit, before room recovery and document projections run.
              deferUntilDrizzleCommit(() => {
                committedAt = performance.now();
              });
              // The branch's owner enters the boundary after the claim, as Discard's does.
              const answer = await deps.workProjection.mutate(
                { branches: [branchId] },
                async (): Promise<ApplyClickResult> => {
                  if (!(await deps.branches.lockActive(branchId))) return closed();
                  const nodes = items.map((item) => item.node);
                  const revisions = await branchRowRevisions(db, branchId, nodes);
                  const reviewItems = new Map(
                    (await deps.branchTree.read(branchId, [], nodes as DocumentId[])).map(
                      (item) => [item.documentId as string, item],
                    ),
                  );
                  const outcome = await treeHalf.apply({
                    branchId,
                    userId,
                    commandId,
                    restore: request.restore === true,
                    items: items.map((item) => ({
                      node: item.node,
                      cut: item.tree,
                      revision: revisions.get(item.node),
                      item: reviewItems.get(item.node) ?? null,
                    })),
                  });
                  if (outcome.kind !== "applied") return { status: outcome.kind, commandId };
                  const { applied } = outcome;
                  // The text half, after the tree half, in id order: every document's key is
                  // held (`treeHalf.apply`). A delete takes the document out of live: its
                  // text has nowhere to merge.
                  let ordinal = 0;
                  let overrode = 0;
                  let textEffect = false;
                  for (const item of [...items].sort((a, b) => a.node.localeCompare(b.node))) {
                    if (!item.text || reviewItems.get(item.node)?.change === "deleting") continue;
                    const wrote = await applyText(
                      command,
                      item.node as DocumentId,
                      item.text,
                      ordinal,
                    );
                    ordinal += item.text.click.groups.length;
                    overrode += wrote.overrode;
                    textEffect = true;
                    const itemKey = draftItemKey(branchId, item.node as DocumentId);
                    if (!applied.some((entry) => entry.itemKey === itemKey))
                      applied.push({ itemKey });
                  }
                  return {
                    status: "applied",
                    commandId,
                    applied,
                    ...(textEffect ? { textEffect: true as const } : {}),
                    ...(overrode ? { overrode } : {}),
                    ...(outcome.restored ? { restored: true as const } : {}),
                  };
                },
                { requireActive: true, seam: true },
              );
              if (answer.status === "applied") await treeHalf.recordCreatedHeads(commandId);
              return answer;
            },
            applyRefusal,
          ),
        );
      } catch (cause) {
        throw asLifecycleRefusal(cause);
      } finally {
        deps.measured({
          commandId,
          boundaryMs: (committedAt ?? performance.now()) - boundaryStart,
        });
      }
    },
  };
}
