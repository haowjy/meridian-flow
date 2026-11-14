/**
 * Atomic Apply: Work lock, command claim, committed live effect and prefix-authored base.
 * A click's tree cut runs first, in the list that holds the document's drafted records: the
 * package's `applyDraft` appends live copies and settles the drafted ones, in this transaction
 * (`drizzle-apply-tree.ts`); then the document's text merges at the result. A document live has in
 * Trash comes back only when the click carries the writer's `restore`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendApplyRecord,
  applyBase,
  baseViewDelta,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  removeApplyRecords,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { InversePart, UpdateJournal } from "@meridian/agent-edit/integration";
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
  type ApplyClickCommand,
  ApplyClickRefused,
  type ApplyCommandStore,
  type ApplyTreeCommand,
} from "../domain/apply-click.js";
import type { Branches } from "../domain/branches.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
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
    onCommitted(documentId: ApplyClickCommand["documentId"]): Promise<void>;
    measured(input: {
      commandId: string;
      compileClickMs?: number;
      boundaryMs?: number;
      holdMs?: number;
    }): void;
  },
): ApplyCommandStore {
  const closed = (command: ApplyClickCommand): ApplyClickResult => ({
    status: "closed",
    commandId: command.envelope.commandId,
  });
  const treeHalf = createApplyTreeOperations({
    db,
    treeLists: deps.treeLists,
    tree: deps.tree,
    close: deps.close,
    arrivals: deps.arrivals,
    onCommitted: deps.onCommitted,
  });

  return {
    async loadBase(command) {
      const draftId = command.request.draftId;
      if (!draftId) return null;
      const [identity] = await currentDrizzleDb(db)
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
        .where(
          and(
            eq(documentDrafts.id, draftId),
            eq(documentDrafts.documentId, command.documentId),
            eq(documentDrafts.kind, "work_draft"),
            eq(documentDrafts.status, "active"),
            eq(branches.id, command.branchId),
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
                const lists = (await treeListsOfBranch(db, prepared.branchId)).filter((list) =>
                  prepared.trees.some((tree) => tree.scope === list.kind),
                );
                await deps.treeLists.lock(lists);
                const created = lists.length
                  ? await deps.treeLists.read({
                      lists,
                      view: (ends) =>
                        ends.flatMap(({ writer }) => appliedCreates(writer, applyCommandId)),
                    })
                  : [];
                const documentIds = new Set<string>(created);
                if (prepared.text) documentIds.add(prepared.text.documentId);
                for (const id of [...documentIds].sort())
                  await lockDocumentMutation(tx, id as DocumentId);
                /** The tree half, whole or not at all: it runs after every check that can end the command quietly. */
                const undoTree = async () => {
                  if (lists.length === 0) return;
                  const written = await textWrittenSince(
                    db,
                    Object.assign({}, ...prepared.trees.map((tree) => tree.createdHeads)),
                  );
                  await deps.treeLists.submit({
                    lists,
                    make: (ends) => {
                      for (const [at, { writer }] of ends.entries()) {
                        const mark = prepared.trees.find(
                          (tree) => tree.scope === lists[at]?.kind,
                        )?.mark;
                        const outcome = mark
                          ? undoApply(writer, applyCommandId, mark, by, commandId, written)
                          : "superseded";
                        if (outcome !== "undone") throw new TreeRefusal(outcome);
                      }
                    },
                  });
                };
                if (!prepared.text) {
                  await undoTree();
                  return {
                    status: "unapplied",
                    commandId,
                    reversedGroupIds: [],
                    skippedGroupIds: [],
                  };
                }
                const { documentId, effects: stored } = prepared.text;
                const currentBase = await deps.coordinator.loadBase(
                  prepared.text.base.snapshot.draftId,
                );
                if (
                  currentBase.snapshot.status === "closed" ||
                  currentBase.snapshot.documentId !== documentId ||
                  currentBase.snapshot.branchId !== prepared.branchId
                )
                  return closed();
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
                const effects = stored.filter((effect) => activeOrdinals.has(effect.ordinal));
                if (!effects.length) return { status: "refused", commandId };

                const snapshot = await deps.live.read(documentId);
                const live = storedDocument(snapshot);
                try {
                  const history = await loadUnapplyHistory(
                    db,
                    documentId,
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
                    targeted.map(({ part }) => ({ part, direction: "invert" as const })),
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
                  const reversedWithLive = reversed.filter(
                    (effect) => effect.liveUpdateSeq !== null,
                  );
                  const skipped = effects.filter(
                    (effect) => !reversed.some((candidate) => candidate.ordinal === effect.ordinal),
                  );
                  if (!reversed.length) {
                    await undoTree();
                    return {
                      status: "unapplied",
                      commandId,
                      reversedGroupIds: [],
                      skippedGroupIds: skipped.map((effect) => effect.groupId),
                    };
                  }
                  await undoTree();
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
                      documentId: documentId,
                      actor: "human",
                      actorUserId: command.envelope.accountId,
                      kind: "undo",
                      actionId: commandId,
                      commandId,
                      receipts,
                    });

                  const groupIds = new Set(reversed.map((effect) => effect.groupId));
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
                          for (const effect of [...reversedWithLive].reverse())
                            current = rebase(
                              schema,
                              effect.baseAfter.map((node) => schema.nodeFromJSON(node)),
                              current,
                              effect.baseBefore.map((node) => schema.nodeFromJSON(node)),
                            ).blocks;
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
                  await tx
                    .update(applyCommandEffects)
                    .set({ unappliedBy: commandId })
                    .where(
                      and(
                        eq(applyCommandEffects.commandId, applyCommandId),
                        inArray(
                          applyCommandEffects.ordinal,
                          reversed.map((effect) => effect.ordinal),
                        ),
                        isNull(applyCommandEffects.unappliedBy),
                      ),
                    );
                  const answer: UnapplyClickResult = {
                    status: "unapplied",
                    commandId,
                    reversedGroupIds: reversed.map((effect) => effect.groupId),
                    skippedGroupIds: skipped.map((effect) => effect.groupId),
                  };
                  deferUntilDrizzleCommit(async () => {
                    await deps.liveCoordinator.deliver(documentId);
                    await deps.onCommitted(documentId);
                  });
                  return answer;
                } finally {
                  live.destroy();
                }
              },
              { requireActive: true, seam: true },
            ),
          unapplyRefusal,
        );
      } catch (cause) {
        throw asLifecycleRefusal(cause);
      }
    },
    async applyTree(command: ApplyTreeCommand) {
      const { branchId, request } = command;
      const commandId = command.envelope.commandId;
      const userId = command.envelope.accountId as UserId;
      try {
        return await runCommand(
          db,
          command.envelope,
          () =>
            deps.workProjection.mutate(
              { branches: [branchId] },
              async (): Promise<ApplyClickResult> => {
                if (!(await deps.branches.lockActive(branchId)))
                  return { status: "closed", commandId };
                const nodes = request.items.map((entry) => entry.node);
                const revisions = await branchRowRevisions(db, branchId, nodes);
                const documents = new Map(
                  (await deps.branchTree.read(branchId, [], nodes as DocumentId[])).map((item) => [
                    item.documentId as string,
                    item,
                  ]),
                );
                const outcome = await treeHalf.apply({
                  branchId,
                  userId,
                  commandId,
                  restore: request.restore === true,
                  items: request.items.map((entry) => ({
                    node: entry.node,
                    cut: { revision: entry.revision },
                    revision: revisions.get(entry.node),
                    item: documents.get(entry.node) ?? null,
                  })),
                });
                if (outcome.kind !== "applied") return { status: outcome.kind, commandId };
                await treeHalf.recordCreatedHeads(commandId);
                return {
                  status: "applied",
                  commandId,
                  applied: outcome.applied,
                  ...(outcome.restored ? { restored: true as const } : {}),
                };
              },
              { requireActive: true, seam: true },
            ),
          (cause) =>
            cause instanceof ApplyClickRefused
              ? { status: "refused", commandId, reason: cause.reason }
              : undefined,
        );
      } catch (cause) {
        throw asLifecycleRefusal(cause);
      }
    },
    measured: deps.measured,
    async apply(command, prepared) {
      const base = prepared.kind === "text" ? prepared.base : null;
      const click = prepared.kind === "text" ? prepared.click : null;
      const cut = prepared.tree ?? null;
      const branchId =
        prepared.kind === "text" ? prepared.base.snapshot.branchId : prepared.branchId;
      const userId = command.envelope.accountId as UserId;
      const applyRefusal = (cause: unknown): ApplyClickResult | undefined =>
        cause instanceof ApplyClickRefused
          ? { status: "refused", commandId: command.envelope.commandId, reason: cause.reason }
          : cause instanceof DraftStaleUpdateError
            ? closed(command)
            : undefined;
      await testHook("apply.beforeBoundary");
      const boundaryStart = performance.now();
      let committedAt: number | undefined;
      try {
        return await applyTiming.run(
          { commandId: command.envelope.commandId, measured: deps.measured },
          () =>
            runCommand(
              db,
              command.envelope,
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
                    const tx = currentDrizzleDb(db);
                    if (!(await deps.branches.lockActive(branchId))) return closed(command);
                    const [item = null] = await deps.branchTree.read(
                      branchId,
                      [],
                      [command.documentId],
                    );
                    const outcome = await treeHalf.apply({
                      branchId,
                      userId,
                      commandId: command.envelope.commandId,
                      restore: command.request.restore === true,
                      items: [
                        {
                          node: command.documentId,
                          cut,
                          revision: item?.revision ?? undefined,
                          item,
                        },
                      ],
                    });
                    if (outcome.kind !== "applied")
                      return { status: outcome.kind, commandId: command.envelope.commandId };
                    const restored = outcome.restored;
                    const applied = outcome.applied;
                    if (!applied.length)
                      applied.push({ itemKey: draftItemKey(branchId, command.documentId) });
                    // The text half: the document's mutex follows the list's lock.
                    await lockDocumentMutation(tx, command.documentId);
                    // A delete takes the document out of live: its text has nowhere to merge.
                    if (!base || !click || item?.change === "deleting") {
                      deferUntilDrizzleCommit(() => deps.onCommitted(command.documentId));
                      return {
                        status: "applied",
                        commandId: command.envelope.commandId,
                        applied,
                        ...(restored ? { restored } : {}),
                      };
                    }
                    const { schema } = click;
                    const snapshot = await deps.live.read(command.documentId);
                    const live = storedDocument(snapshot);
                    let update: Uint8Array | undefined;
                    const capture = (bytes: Uint8Array) => {
                      update = bytes;
                    };
                    live.on("update", capture);
                    try {
                      const merged = rebase(
                        schema,
                        click.optimistic,
                        readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
                        click.patched,
                      );
                      const liveEffects: { groupId: string; seq: number | null }[] = [];
                      for (const group of click.groups) {
                        const groupMerge = rebase(
                          schema,
                          click.optimistic,
                          readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
                          group.patched,
                        );
                        update = undefined;
                        live.transact(
                          () =>
                            writeBlocks(
                              live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
                              schema,
                              groupMerge.blocks,
                            ),
                          "apply",
                        );
                        const seq = update
                          ? await deps.live.append(
                              command.documentId,
                              update,
                              { seq: 0, origin: `human:${command.envelope.accountId}` },
                              snapshot.authority,
                            )
                          : null;
                        liveEffects.push({ groupId: group.groupId, seq });
                      }
                      await stampLiveEditsWithCommand(
                        tx,
                        command.envelope.commandId,
                        liveEffects.flatMap((effect) => (effect.seq === null ? [] : [effect.seq])),
                      );
                      await testHook("apply.afterLive");
                      const baseEffects: {
                        groupId: string;
                        start?: unknown[];
                        delta: unknown[];
                      }[] = [];
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
                              const after = applyBase(
                                schema,
                                before,
                                click.optimistic,
                                group.patched,
                              );
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
                        click.groups.map((group, ordinal) => {
                          const liveEffect = liveEffects.find(
                            (effect) => effect.groupId === group.groupId,
                          );
                          const baseEffect = baseEffects.find(
                            (effect) => effect.groupId === group.groupId,
                          );
                          if (!liveEffect || !baseEffect)
                            throw new Error("Apply effect was not captured");
                          return {
                            commandId: command.envelope.commandId,
                            ordinal,
                            groupId: group.groupId,
                            documentId: command.documentId,
                            draftId: base.snapshot.draftId,
                            liveUpdateSeq: liveEffect.seq,
                            baseStart: baseEffect.start,
                            baseDelta: baseEffect.delta,
                          };
                        }),
                      );
                      const overrode = merged.overrode;
                      const answer: ApplyClickResult = {
                        status: "applied",
                        commandId: command.envelope.commandId,
                        applied,
                        textEffect: true,
                        ...(overrode ? { overrode } : {}),
                        ...(restored ? { restored } : {}),
                      };
                      deferUntilDrizzleCommit(async () => {
                        await deps.liveCoordinator.deliver(command.documentId);
                        await deps.onCommitted(command.documentId);
                      });
                      return answer;
                    } finally {
                      live.off("update", capture);
                      live.destroy();
                    }
                  },
                  { requireActive: true, seam: true },
                );
                if (answer.status === "applied")
                  await treeHalf.recordCreatedHeads(command.envelope.commandId);
                return answer;
              },
              applyRefusal,
            ),
        );
      } catch (cause) {
        throw asLifecycleRefusal(cause);
      } finally {
        deps.measured({
          commandId: command.envelope.commandId,
          boundaryMs: (committedAt ?? performance.now()) - boundaryStart,
        });
      }
    },
  };
}
