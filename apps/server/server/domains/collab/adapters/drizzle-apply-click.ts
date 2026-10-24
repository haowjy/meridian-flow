/**
 * Atomic Apply: Work lock, command claim, committed live effect, prefix-authored base and trail.
 * A click's tree cut runs first, keyed on the branch's logical state for the document and its
 * live state (design-v2 §4): a delete removes it live, a move moves it (or restores it there,
 * or reveals it there), a creation reveals it; then the branch's row goes with settlement rows.
 * A document deleted live comes back only when the click carries the writer's `restore`
 * (`restoreDocument`, D79), then the text merges.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
import type {
  AgentEditCodecFactory,
  AgentEditModel,
  InversePart,
  UpdateJournal,
} from "@meridian/agent-edit/integration";
import { computeInverse } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { type BranchId, type DocumentId, draftItemKey, type UserId } from "@meridian/contracts";
import type {
  AppliedReviewItem,
  ApplyClickAnswer,
  ApplyClickResult,
  ApplyRenamedNote,
} from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import {
  applyCommandEffects,
  branchCommands,
  branches,
  changeTrailDirtyLog,
  documentDrafts,
  pushLineage,
} from "@meridian/database/schema";
import {
  allocateDocumentClient,
  buildDocumentSchema,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleSavepoint,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import { endCreatedFact } from "../../context/tree/branch-tree-store.js";
import { movePlacementCycle } from "../../context/tree/live-tree-state.js";
import { acquireTreeScope, TreeScopeChangedError } from "../../context/tree/mutation-scope.js";
import { restoreDocument } from "../../context/tree/removal.js";
import { createTreeReader, LIVE_TREE, type TreeStateNode } from "../../context/tree/tree-view.js";
import { loadDocumentIdentityRows } from "../../context/tree/tree-view-sql.js";
import {
  WorkLifecycleUnavailableError,
  type WorkProjectionMutation,
} from "../../projects/index.js";
import {
  type ApplyClickCommand,
  ApplyClickRefused,
  type ApplyCommandStore,
} from "../domain/apply-click.js";
import { BranchCommandExistsError } from "../domain/branch-commands.js";
import type { Branches } from "../domain/branches.js";
import { describeTrailBlocks, trailBlockChanges } from "../domain/document-difference.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import { DraftStaleUpdateError } from "../domain/draft-store.js";
import {
  persistDurableTrailRecords,
  preparedTrailChanges,
} from "../domain/draft-trail-projection.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import { storedDocument } from "./document-loader.js";
import { createApplyTreeOperations, liveLocation } from "./drizzle-apply-tree.js";
import { claimCommandWithinTx, lookupCommand } from "./drizzle-branch-commands.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { loadPreparedUnapply, loadUnapplyHistory } from "./drizzle-unapply-read.js";

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
    model: AgentEditModel;
    codec: AgentEditCodecFactory;
    links: DocumentLinkScopes;
    trail: ChangeTrailPersistence;
    arrivals?: Pick<DocumentArrivals, "settle">;
    catalog: ContextCatalogMutationPort;
    removal: DocumentRemoval;
    close: Pick<DraftClose, "closeDrafts">;
    /** After commit: delete a tombstoned creation's stored object, best effort. */
    releaseObjects(storageUrls: readonly string[]): Promise<void>;
    onCommitted(documentId: ApplyClickCommand["documentId"]): Promise<void>;
    measured(input: {
      commandId: string;
      compileClickMs?: number;
      boundaryMs?: number;
      holdMs?: number;
    }): void;
  },
): ApplyCommandStore {
  const tree = createTreeReader(db);
  const closed = (command: ApplyClickCommand): ApplyClickResult => ({
    status: "closed",
    commandId: command.envelope.commandId,
  });
  /** The addressed document's node in the branch, never another created document's. */
  async function itemNode(branchId: BranchId, documentId: DocumentId) {
    const nodes = await tree.treeState(branchId, [documentId], [documentId]);
    return nodes.find((node) => node.nodeId === documentId);
  }

  type DependencyPlan = {
    nodes: Map<DocumentId, TreeStateNode>;
    chain: DocumentId[];
    cycleAt: number | null;
  };

  /** The live occupant chain that this one click owns under the branch lock. */
  async function dependencyPlan(branchId: BranchId, root: DocumentId): Promise<DependencyPlan> {
    const nodes = new Map<DocumentId, TreeStateNode>();
    const chain: DocumentId[] = [];
    const positions = new Map<DocumentId, number>();
    let cycleAt: number | null = null;
    let documentId: DocumentId | null = root;
    while (documentId) {
      const repeated = positions.get(documentId);
      if (repeated !== undefined) {
        cycleAt = repeated;
        break;
      }
      const node = await itemNode(branchId, documentId);
      if (!node) break;
      positions.set(documentId, chain.length);
      chain.push(documentId);
      nodes.set(documentId, node);
      if (node.branch?.state !== "moving") break;
      const found = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: node.target.contextSourceId,
        path: node.target.path,
        as: "document",
      });
      if (found.kind !== "found" || found.node.kind !== "document") break;
      const occupant = found.node.document.id;
      if (occupant === documentId) break;
      const other = await itemNode(branchId, occupant);
      if (!other?.branch || (!other.branch.moved && !other.branch.deleted)) break;
      documentId = occupant;
    }
    return { nodes, chain, cycleAt };
  }

  function displayedPath(node: TreeStateNode, path: string): string {
    const marker = node.target.uri?.indexOf("://") ?? -1;
    return marker < 0 ? path : `${node.target.uri?.slice(0, marker + 3)}${path}`;
  }

  async function renamedNote(node: TreeStateNode): Promise<ApplyRenamedNote | undefined> {
    const found = await tree.findById(LIVE_TREE, node.nodeId);
    if (found.kind !== "found" || found.document.path === node.target.path) return undefined;
    return {
      code: "renamed",
      wanted: node.target.uri ?? node.target.path,
      path: displayedPath(node, found.document.path),
    };
  }

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
            eq(branches.originWorkId, command.workId),
            eq(branches.status, "active"),
          ),
        );
      if (!identity) return null;
      try {
        return await deps.coordinator.loadBase(draftId);
      } catch (cause) {
        // A hidden-create removal may release its bytes between resolution and this read.
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
      const closed = (): import("@meridian/contracts/branches").UnapplyClickResult => ({
        status: "closed",
        commandId,
      });
      try {
        return await deps.workProjection.mutate(
          { works: [command.workId] },
          async (): Promise<import("@meridian/contracts/branches").UnapplyClickAnswer> => {
            const tx = currentDrizzleDb(db);
            const found = await lookupCommand(tx, command.envelope);
            if (found.kind === "done")
              return found.commandKind === "unapply_click"
                ? (found.result as import("@meridian/contracts/branches").UnapplyClickResult)
                : { status: "conflict", commandId };
            if (found.kind !== "none") return { status: found.kind, commandId };
            if (
              !(await claimCommandWithinTx(tx, {
                ...command.envelope,
                branchId: prepared.branchId,
              }))
            )
              throw new BranchCommandExistsError(commandId);
            const finish = async (
              result: import("@meridian/contracts/branches").UnapplyClickResult,
            ) => {
              await tx
                .update(branchCommands)
                .set({ state: "done", result, completedAt: sql`clock_timestamp()` })
                .where(eq(branchCommands.id, commandId));
              return result;
            };
            if (!(await deps.branches.lockActive(prepared.branchId))) return finish(closed());
            await lockDocumentMutation(tx, command.documentId);
            const currentBase = await deps.coordinator.loadBase(prepared.base.snapshot.draftId);
            if (
              currentBase.snapshot.status === "closed" ||
              currentBase.snapshot.documentId !== command.documentId ||
              currentBase.snapshot.branchId !== prepared.branchId
            )
              return finish(closed());
            const stillActive = await tx
              .select({ ordinal: applyCommandEffects.ordinal })
              .from(applyCommandEffects)
              .where(
                and(
                  eq(applyCommandEffects.commandId, command.request.applyCommandId),
                  isNull(applyCommandEffects.unappliedBy),
                ),
              );
            const activeOrdinals = new Set(stillActive.map((row) => row.ordinal));
            const effects = prepared.effects.filter((effect) => activeOrdinals.has(effect.ordinal));
            if (!effects.length) return finish({ status: "refused", commandId });

            const snapshot = await deps.live.read(command.documentId);
            const live = storedDocument(snapshot);
            try {
              const history = await loadUnapplyHistory(
                db,
                command.documentId,
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
              const reversedWithLive = reversed.filter((effect) => effect.liveUpdateSeq !== null);
              const skipped = effects.filter(
                (effect) => !reversed.some((candidate) => candidate.ordinal === effect.ordinal),
              );
              if (!reversed.length)
                return finish({
                  status: "unapplied",
                  commandId,
                  reversedGroupIds: [],
                  skippedGroupIds: skipped.map((effect) => effect.groupId),
                });
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
                    command.documentId,
                    update,
                    { seq: 0, origin: "system" },
                    snapshot.authority,
                  );
                  receipts.push({ ...part, update, origin: { kind: "live", seq } });
                }
              }
              if (receipts.length)
                await recordDocumentEdit(tx, {
                  documentId: command.documentId,
                  actor: "human",
                  actorUserId: command.envelope.accountId,
                  kind: "undo",
                  actionId: commandId,
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
                      removeApplyRecords(prefix, command.request.applyCommandId, groupIds);
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
                    eq(applyCommandEffects.commandId, command.request.applyCommandId),
                    inArray(
                      applyCommandEffects.ordinal,
                      reversed.map((effect) => effect.ordinal),
                    ),
                    isNull(applyCommandEffects.unappliedBy),
                  ),
                );
              const answer: import("@meridian/contracts/branches").UnapplyClickResult = {
                status: "unapplied",
                commandId,
                reversedGroupIds: reversed.map((effect) => effect.groupId),
                skippedGroupIds: skipped.map((effect) => effect.groupId),
              };
              await finish(answer);
              deferUntilDrizzleCommit(async () => {
                await deps.liveCoordinator.deliver(command.documentId);
                await deps.onCommitted(command.documentId);
              });
              return answer;
            } finally {
              live.destroy();
            }
          },
          { requireActive: true, seam: true },
        );
      } catch (cause) {
        if (cause instanceof DraftStaleUpdateError) return closed();
        if (cause instanceof WorkLifecycleUnavailableError)
          throw new ApplyClickRefused(
            cause.state === "archived"
              ? "work_archived"
              : cause.state === "deleted"
                ? "work_deleted"
                : "not_found",
          );
        throw cause;
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
      await testHook("apply.beforeBoundary");
      const boundaryStart = performance.now();
      let committedAt: number | undefined;
      // A restore or reveal locks the document's namespace before the document. Once an
      // attempt finds that scope needed, every later attempt takes it from the start.
      let treeScope = false;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await applyTiming.run(
              { commandId: command.envelope.commandId, measured: deps.measured },
              () =>
                deps.workProjection.mutate(
                  // A tree cut writes the branch's row: its branch too, as Discard holds it.
                  { works: [command.workId], ...(cut ? { branches: [branchId] } : {}) },
                  async (): Promise<ApplyClickAnswer> => {
                    // mutate awaits post-commit delivery too; stop the boundary clock at
                    // root commit, before room recovery and document projections run.
                    deferUntilDrizzleCommit(() => {
                      committedAt = performance.now();
                    });
                    const tx = currentDrizzleDb(db);
                    const found = await lookupCommand(tx, command.envelope);
                    if (found.kind === "done")
                      return found.commandKind === "apply_click"
                        ? (found.result as ApplyClickResult)
                        : { status: "conflict", commandId: command.envelope.commandId };
                    if (found.kind !== "none")
                      return { status: found.kind, commandId: command.envelope.commandId };
                    if (
                      !(await claimCommandWithinTx(tx, {
                        ...command.envelope,
                        branchId: branchId,
                      }))
                    )
                      throw new BranchCommandExistsError(command.envelope.commandId);
                    const finish = async (result: ApplyClickResult) => {
                      await tx
                        .update(branchCommands)
                        .set({ state: "done", result, completedAt: sql`clock_timestamp()` })
                        .where(eq(branchCommands.id, command.envelope.commandId));
                      return result;
                    };
                    if (!(await deps.branches.lockActive(branchId))) return finish(closed(command));
                    // Only a tree cut, a hidden-create reveal or a deleted document's restore
                    // changes the tree. Ordinary text Apply must not serialize unrelated
                    // documents on their source's namespace lock.
                    const lifecycle = async () => {
                      const [row] = await loadDocumentIdentityRows(tx, [command.documentId]);
                      if (!row) throw new ApplyClickRefused("not_found");
                      return row;
                    };
                    const guess = await lifecycle();
                    treeScope ||= guess.hidden || guess.deleted || cut !== null;
                    await testHook("apply.afterScopeGuess");
                    const guessedPlan = cut
                      ? await dependencyPlan(branchId, command.documentId)
                      : null;
                    const scopeIds = guessedPlan
                      ? [...guessedPlan.nodes.keys()]
                      : [command.documentId];
                    if (treeScope)
                      await acquireTreeScope(db, {
                        branches: [{ branchId, documentIds: scopeIds }],
                        documentIds: scopeIds,
                      });
                    else await lockDocumentMutation(tx, command.documentId);
                    const locked = await lifecycle();
                    if (locked.deleted && !treeScope) {
                      // A delete committed between the guess and the lock: start over
                      // namespace-first, never taking a namespace under a document lock.
                      treeScope = true;
                      throw new TreeScopeChangedError();
                    }
                    const node = await itemNode(branchId, command.documentId);
                    // The click applies exactly the row revision the writer saw.
                    if (
                      cut &&
                      (!node?.branch || (node.branch.revision?.toString() ?? null) !== cut.revision)
                    )
                      return finish({ status: "changed", commandId: command.envelope.commandId });
                    const state = cut ? (node?.branch?.state ?? null) : null;
                    // Only the writer's knowledge brings a document back: a delete their view
                    // did not show leaves the click undone and the draft pending (D79). A
                    // hidden tombstone is a discarded creation, never asked about.
                    if (
                      state !== "deleting" &&
                      locked.deleted &&
                      !locked.hidden &&
                      !command.request.restore
                    )
                      return finish({
                        status: "needs_restore",
                        commandId: command.envelope.commandId,
                      });
                    let restored = false;
                    const applied: AppliedReviewItem[] = [];
                    const treeOperations = createApplyTreeOperations({
                      db,
                      branchId,
                      commandDocumentId: command.documentId,
                      userId,
                      removal: deps.removal,
                      close: deps.close,
                      arrivals: deps.arrivals,
                      catalog: deps.catalog,
                      releaseObjects: deps.releaseObjects,
                      onCommitted: deps.onCommitted,
                      findLive: (documentId) => tree.findById(LIVE_TREE, documentId),
                      resolveLivePath: async (path) => {
                        const occupant = await tree.resolvePath(LIVE_TREE, {
                          contextSourceId: node?.target.contextSourceId ?? locked.contextSourceId,
                          path,
                          as: "folder",
                        });
                        if (occupant.kind === "not_found") return "free";
                        return occupant.kind === "ambiguous" || occupant.node.kind === "document"
                          ? "blocked"
                          : "folder";
                      },
                      renamedNote,
                      displayedPath,
                    });

                    if (cut && node) {
                      const plan = await dependencyPlan(branchId, command.documentId);
                      const scoped = new Set(scopeIds);
                      if ([...plan.nodes.keys()].some((id) => !scoped.has(id)))
                        throw new TreeScopeChangedError();
                      const tolerateDependency = async (
                        operation: () => Promise<AppliedReviewItem[]>,
                      ): Promise<AppliedReviewItem[]> => {
                        try {
                          return await runInDrizzleSavepoint(db, operation);
                        } catch (cause) {
                          if (!(cause instanceof ApplyClickRefused)) throw cause;
                          return [];
                        }
                      };
                      const cycleIds = plan.cycleAt === null ? [] : plan.chain.slice(plan.cycleAt);
                      if (cycleIds.length) {
                        const cycleNodes = cycleIds.map(
                          (id) => plan.nodes.get(id) as TreeStateNode,
                        );
                        const installCycle = async (): Promise<AppliedReviewItem[]> => {
                          const before = new Map(
                            await Promise.all(
                              cycleNodes.map(async (cycleNode) => {
                                const found = await tree.findById(LIVE_TREE, cycleNode.nodeId);
                                return [
                                  cycleNode.nodeId,
                                  found.kind === "found"
                                    ? displayedPath(cycleNode, found.document.path)
                                    : null,
                                ] as const;
                              }),
                            ),
                          );
                          await movePlacementCycle(
                            db,
                            cycleNodes.map((cycleNode) => ({
                              documentId: cycleNode.nodeId,
                              to: liveLocation(cycleNode),
                            })),
                            { arrivals: deps.arrivals, catalog: deps.catalog },
                          );
                          const items: AppliedReviewItem[] = [];
                          for (const cycleNode of cycleNodes)
                            items.push(
                              await treeOperations.settle(
                                cycleNode,
                                before.get(cycleNode.nodeId) ?? null,
                              ),
                            );
                          return items;
                        };
                        applied.push(
                          ...(plan.cycleAt === 0
                            ? await installCycle()
                            : await tolerateDependency(installCycle)),
                        );
                      }
                      const beforeCycle = plan.cycleAt ?? plan.chain.length;
                      for (let index = beforeCycle - 1; index >= 0; index--) {
                        const planned = plan.nodes.get(plan.chain[index] as DocumentId);
                        if (!planned) continue;
                        if (index === 0) {
                          const outcome = await treeOperations.apply(planned);
                          applied.push(outcome.item);
                          restored ||= outcome.restored;
                        } else
                          applied.push(
                            ...(await tolerateDependency(async () => [
                              (await treeOperations.apply(planned)).item,
                            ])),
                          );
                      }
                      if (state === "deleting")
                        return finish({
                          status: "applied",
                          commandId: command.envelope.commandId,
                          applied,
                        });
                    } else {
                      if (locked.deleted) {
                        const outcome = await restoreDocument(
                          db,
                          { documentId: command.documentId },
                          { arrivals: deps.arrivals, catalog: deps.catalog },
                        );
                        if (outcome.kind === "ancestor_taken")
                          throw new ApplyClickRefused("ancestor_taken");
                        if (outcome.kind === "refused") return finish(closed(command));
                        restored = outcome.kind === "restored";
                      }
                      if (node?.hidden && node.origin === "created" && base) {
                        await treeOperations.reveal(node, {
                          contextSourceId: locked.contextSourceId,
                          parentFolderId: locked.folderId,
                          name: locked.name,
                          extension: locked.extension,
                        });
                      }
                    }
                    if (!cut && node?.origin === "created")
                      await endCreatedFact(db, { branchId, documentId: command.documentId });
                    if (
                      !applied.some(
                        ({ itemKey }) => itemKey === draftItemKey(branchId, command.documentId),
                      )
                    ) {
                      const renamed = node ? await renamedNote(node) : undefined;
                      applied.push({
                        itemKey: draftItemKey(branchId, command.documentId),
                        ...(renamed ? { renamed } : {}),
                      });
                    }
                    if (!base || !click) {
                      deferUntilDrizzleCommit(() => deps.onCommitted(command.documentId));
                      return finish({
                        status: "applied",
                        commandId: command.envelope.commandId,
                        applied,
                        ...(restored ? { restored } : {}),
                      });
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
                      const before = await deps.links.within(
                        { documentId: command.documentId },
                        async () => {
                          await deps.links.prepare({
                            holders: [{ documentId: command.documentId, view: { kind: "live" } }],
                            docs: [live],
                            stored: merged.blocks,
                          });
                          const codec = deps.codec.forScope(
                            deps.links.holder({
                              documentId: command.documentId,
                              view: { kind: "live" },
                            }),
                          );
                          const before = describeTrailBlocks(live, deps.model, codec, schema);
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
                          return {
                            before,
                            after: describeTrailBlocks(live, deps.model, codec, schema),
                            liveEffects,
                          };
                        },
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
                          const liveEffect = before.liveEffects.find(
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
                      const seq =
                        before.liveEffects.find((effect) => effect.seq !== null)?.seq ?? null;
                      const receiptId = randomUUID();
                      const [push] = await tx
                        .insert(pushLineage)
                        .values({
                          draftId: base.snapshot.draftId,
                          documentId: command.documentId,
                          upstreamUpdateSeq: seq,
                          pushedByUserId: command.envelope.accountId,
                          idempotencyKey: command.envelope.commandId,
                          receiptId,
                        })
                        .returning({ id: pushLineage.id });
                      if (!push) throw new Error("Missing Apply lineage");
                      const owners = click.owners;
                      const changes = trailBlockChanges(before.before, before.after);
                      const ownersByBlock = new Map<string, typeof owners>();
                      const effectOwners = new Map<string, typeof owners>();
                      for (const effect of click.effects) {
                        const key = `${effect.side}:${effect.index}`;
                        effectOwners.set(key, [...(effectOwners.get(key) ?? []), ...effect.owners]);
                      }
                      for (const entry of merged.correspondence) {
                        const reached = entry.sources.flatMap(
                          (source) => effectOwners.get(`${source.side}:${source.index}`) ?? [],
                        );
                        const ids =
                          entry.output === null
                            ? entry.sources
                                .filter((source) => source.side === "live")
                                .map((source) => before.before[source.index]?.id)
                            : [
                                before.after[entry.output]?.id,
                                ...entry.sources
                                  .filter((source) => source.side === "live")
                                  .map((source) => before.before[source.index]?.id),
                              ];
                        for (const id of ids)
                          if (id)
                            ownersByBlock.set(id, [...(ownersByBlock.get(id) ?? []), ...reached]);
                      }
                      for (const [id, owners] of ownersByBlock)
                        ownersByBlock.set(id, [
                          ...new Map(
                            owners.map((owner) => [`${owner.threadId}:${owner.turnId}`, owner]),
                          ).values(),
                        ]);
                      await persistDurableTrailRecords(
                        [
                          {
                            push,
                            record: {
                              documentId: command.documentId,
                              documentTitle: node?.target.name ?? "Document",
                              receiptId,
                              threadIds: [...new Set(owners.map((owner) => owner.threadId))],
                              journalOwners: owners,
                              changes: preparedTrailChanges({
                                documentId: command.documentId,
                                changedBlocks: changes,
                                receiptId,
                                ownersByBlock,
                                before: before.before.map((block) => ({
                                  hash: block.id,
                                  serialized: block.serialized,
                                  ...block.identity,
                                })),
                                blockIdentities: new Map(
                                  before.after.map((block) => [
                                    block.id,
                                    { documentId: command.documentId, ...block.identity },
                                  ]),
                                ),
                                afterIds: new Set(before.after.map((block) => block.id)),
                                afterById: new Map(
                                  before.after.map((block) => [block.id, block.block]),
                                ),
                                afterDoc: live,
                              }),
                            },
                          },
                        ],
                        deps.trail,
                      );
                      if (owners.length)
                        await tx.insert(changeTrailDirtyLog).values(
                          owners.flatMap((owner) => [
                            { threadId: owner.threadId, turnId: owner.turnId },
                            { threadId: owner.threadId, turnId: null },
                          ]),
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
                      await finish(answer);
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
                ),
            );
          } catch (cause) {
            if (cause instanceof TreeScopeChangedError && attempt < 3) continue;
            throw cause;
          }
        }
      } catch (cause) {
        // The append door alone locks and rechecks the addressed draft. Closure rolls
        // back the claim and live half with it before the service reads a stored outcome.
        if (cause instanceof DraftStaleUpdateError) return closed(command);
        if (cause instanceof WorkLifecycleUnavailableError)
          throw new ApplyClickRefused(
            cause.state === "archived"
              ? "work_archived"
              : cause.state === "deleted"
                ? "work_deleted"
                : "not_found",
          );
        throw cause;
      } finally {
        deps.measured({
          commandId: command.envelope.commandId,
          boundaryMs: (committedAt ?? performance.now()) - boundaryStart,
        });
      }
    },
  };
}
