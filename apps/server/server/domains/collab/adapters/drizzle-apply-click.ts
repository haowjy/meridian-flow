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
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type {
  AgentEditCodecFactory,
  AgentEditModel,
  UpdateJournal,
} from "@meridian/agent-edit/integration";
import { type BranchId, type DocumentId, draftItemKey, type UserId } from "@meridian/contracts";
import type {
  AppliedReviewItem,
  ApplyClickAnswer,
  ApplyClickResult,
  ApplyRenamedNote,
} from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import {
  branchCommands,
  branches,
  changeTrailDirtyLog,
  documentDrafts,
  pushLineage,
} from "@meridian/database/schema";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import { dropDocumentRows, endCreatedFact } from "../../context/tree/branch-tree-store.js";
import { tombstoneUnused } from "../../context/tree/end-use.js";
import { movePlacementCycle, moveToPlacement } from "../../context/tree/live-tree-state.js";
import { acquireTreeScope, TreeScopeChangedError } from "../../context/tree/mutation-scope.js";
import { place } from "../../context/tree/placement.js";
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
  type ApplyClickStore,
} from "../domain/apply-click.js";
import { BranchCommandExistsError } from "../domain/branch-commands.js";
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
import { storedDocument } from "./document-loader.js";
import { claimCommandWithinTx, lookupCommand } from "./drizzle-branch-commands.js";
import type { DraftClose } from "./drizzle-draft-close.js";

const applyTiming = new AsyncLocalStorage<{
  commandId: string;
  measured: (input: { commandId: string; holdMs: number }) => void;
}>();

/** Uses the append door's actual lock-to-root-commit time, not the server author's CPU time. */
export function measureApplyAppend(detail: { holdMs: number }): void {
  const timing = applyTiming.getStore();
  timing?.measured({ commandId: timing.commandId, holdMs: detail.holdMs });
}

export function createDrizzleApplyClick(
  db: Database,
  deps: {
    workProjection: WorkProjectionMutation;
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
): ApplyClickStore {
  const tree = createTreeReader(db);
  const closed = (command: ApplyClickCommand): ApplyClickResult => ({
    status: "closed",
    commandId: command.envelope.commandId,
  });
  /** Places a hidden creation at `at`; null when a document blocks an ancestor path. */
  async function reveal(
    node: TreeStateNode,
    at: Pick<TreeStateNode["target"], "contextSourceId" | "parentFolderId" | "name" | "extension">,
  ): Promise<TreeStateNode["target"] | null> {
    const placed = await place(db, {
      targets: [
        {
          node: { kind: "document", id: node.nodeId },
          at: {
            contextSourceId: at.contextSourceId,
            parentFolderId: at.parentFolderId,
            name: at.name,
            extension: at.extension,
          },
        },
      ],
    });
    if (!placed.ok) {
      if (placed.error.code === "path_taken") return null;
      throw new ApplyClickRefused("forbidden");
    }
    await deps.arrivals?.settle([node.nodeId]);
    await deps.catalog.refreshSources(
      placed.value.sourceIds,
      placed.value.placed.map((ref) => ref.id),
    );
    const [landed] = placed.value.landed;
    return landed
      ? {
          ...node.target,
          ...landed.at,
          path: node.target.path,
          dir: node.target.dir,
          uri: node.target.uri,
        }
      : null;
  }
  /** The addressed document's node in the branch, never another created document's. */
  async function itemNode(branchId: BranchId, documentId: DocumentId) {
    const nodes = await tree.treeState(branchId, [documentId], [documentId]);
    return nodes.find((node) => node.nodeId === documentId);
  }

  type DependencyPlan = {
    nodes: Map<DocumentId, TreeStateNode>;
    next: Map<DocumentId, DocumentId>;
  };

  /** The live occupant chain that this one click owns under the branch lock. */
  async function dependencyPlan(branchId: BranchId, root: DocumentId): Promise<DependencyPlan> {
    const nodes = new Map<DocumentId, TreeStateNode>();
    const next = new Map<DocumentId, DocumentId>();
    const visit = async (documentId: DocumentId): Promise<void> => {
      if (nodes.has(documentId)) return;
      const node = await itemNode(branchId, documentId);
      if (!node) return;
      nodes.set(documentId, node);
      if (node.branch?.state !== "moving") return;
      const found = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: node.target.contextSourceId,
        path: node.target.path,
        as: "document",
      });
      if (found.kind !== "found" || found.node.kind !== "document") return;
      const occupant = found.node.document.id;
      if (occupant === documentId) return;
      const other = await itemNode(branchId, occupant);
      if (!other?.branch || (!other.branch.moved && !other.branch.deleted)) return;
      next.set(documentId, occupant);
      await visit(occupant);
    };
    await visit(root);
    return { nodes, next };
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
    measured: deps.measured,
    async execute(command, prepared) {
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
                    let replaced: string | undefined;
                    const applied: AppliedReviewItem[] = [];
                    const recordApplied = async (appliedNode: TreeStateNode) => {
                      const renamed = await renamedNote(appliedNode);
                      applied.push({
                        itemKey: draftItemKey(branchId, appliedNode.nodeId),
                        tree: true,
                        ...(renamed ? { renamed } : {}),
                      });
                    };
                    const settleTreeNode = async (appliedNode: TreeStateNode) => {
                      await dropDocumentRows(db, {
                        branchId,
                        documentIds: [appliedNode.nodeId],
                        settle: { as: "applied", userId },
                      });
                      await recordApplied(appliedNode);
                      deferUntilDrizzleCommit(() => deps.onCommitted(appliedNode.nodeId));
                    };
                    const applyTreeNode = async (appliedNode: TreeStateNode) => {
                      const [identity] = await loadDocumentIdentityRows(tx, [appliedNode.nodeId]);
                      if (!identity) throw new ApplyClickRefused("not_found");
                      if (appliedNode.branch?.state === "deleting") {
                        if (!identity.deleted && !identity.hidden) {
                          await deps.removal.remove({
                            documentIds: [appliedNode.nodeId],
                            reason: "deleted",
                            userId,
                          });
                          await deps.catalog.refreshSources(
                            [identity.contextSourceId],
                            [appliedNode.nodeId],
                          );
                        }
                        await deps.close.closeDrafts(
                          tx,
                          { documentIds: [appliedNode.nodeId], branchId },
                          "document_discarded",
                        );
                        await dropDocumentRows(db, {
                          branchId,
                          documentIds: [appliedNode.nodeId],
                          settle: { as: "applied", userId },
                        });
                        if (identity.hidden && !identity.deleted) {
                          const ended = await tombstoneUnused(db, [appliedNode.nodeId], {
                            actor: { userId },
                            removal: deps.removal,
                          });
                          if (ended.tombstoned.length)
                            await deps.catalog.refreshSources(
                              [identity.contextSourceId],
                              ended.tombstoned.map((ref) => ref.id),
                            );
                          if (ended.releasedObjects.length)
                            deferUntilDrizzleCommit(() =>
                              deps.releaseObjects(ended.releasedObjects),
                            );
                        }
                        await recordApplied(appliedNode);
                        deferUntilDrizzleCommit(() => deps.onCommitted(appliedNode.nodeId));
                        return;
                      }
                      if (identity.deleted) {
                        const outcome = await restoreDocument(
                          db,
                          {
                            documentId: appliedNode.nodeId,
                            ...(appliedNode.branch?.state === "moving"
                              ? { at: liveLocation(appliedNode) }
                              : {}),
                          },
                          { arrivals: deps.arrivals, catalog: deps.catalog },
                        );
                        if (outcome.kind === "location_taken")
                          throw new ApplyClickRefused("forbidden");
                        if (outcome.kind === "refused") throw new ApplyClickRefused("not_found");
                        if (appliedNode.nodeId === command.documentId)
                          restored = outcome.kind === "restored";
                      } else if (appliedNode.branch?.state === "moving" && !identity.hidden) {
                        const moved = await moveToPlacement(
                          db,
                          {
                            documentId: appliedNode.nodeId,
                            from: {
                              folderId: identity.folderId,
                              rootSourceId: identity.folderId ? null : identity.contextSourceId,
                              name: identity.name,
                              extension: identity.extension,
                            },
                            to: {
                              folderId: appliedNode.target.parentFolderId,
                              rootSourceId: appliedNode.target.parentFolderId
                                ? null
                                : appliedNode.target.contextSourceId,
                              name: appliedNode.target.name,
                              extension: appliedNode.target.extension,
                            },
                          },
                          { arrivals: deps.arrivals, catalog: deps.catalog },
                        );
                        if (moved.kind !== "moved") throw new ApplyClickRefused("forbidden");
                        if (appliedNode.nodeId === command.documentId)
                          replaced = appliedNode.from?.uri ?? appliedNode.from?.path;
                      }
                      if (appliedNode.hidden && appliedNode.origin === "created") {
                        if (!(await reveal(appliedNode, appliedNode.target)))
                          throw new ApplyClickRefused("forbidden");
                      }
                      await settleTreeNode(appliedNode);
                    };

                    if (cut && node) {
                      const plan = await dependencyPlan(branchId, command.documentId);
                      if ([...plan.nodes.keys()].some((id) => !scopeIds.includes(id)))
                        throw new TreeScopeChangedError();
                      const done = new Set<DocumentId>();
                      const visiting: DocumentId[] = [];
                      const applyOrdered = async (documentId: DocumentId): Promise<void> => {
                        if (done.has(documentId)) return;
                        const cycleAt = visiting.indexOf(documentId);
                        if (cycleAt >= 0) {
                          const cycle = visiting.slice(cycleAt);
                          const cycleNodes = cycle.map((id) => plan.nodes.get(id) as TreeStateNode);
                          await movePlacementCycle(
                            db,
                            cycleNodes.map((cycleNode) => ({
                              documentId: cycleNode.nodeId,
                              to: liveLocation(cycleNode),
                            })),
                            { arrivals: deps.arrivals, catalog: deps.catalog },
                          );
                          for (const cycleNode of cycleNodes) {
                            if (cycleNode.nodeId === command.documentId)
                              replaced = cycleNode.from?.uri ?? cycleNode.from?.path;
                            await settleTreeNode(cycleNode);
                            done.add(cycleNode.nodeId);
                          }
                          return;
                        }
                        visiting.push(documentId);
                        const dependency = plan.next.get(documentId);
                        if (dependency) await applyOrdered(dependency);
                        visiting.pop();
                        if (done.has(documentId)) return;
                        const planned = plan.nodes.get(documentId);
                        if (planned) await applyTreeNode(planned);
                        done.add(documentId);
                      };
                      await applyOrdered(command.documentId);
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
                        if (outcome.kind === "location_taken")
                          throw new ApplyClickRefused("forbidden");
                        if (outcome.kind === "refused") return finish(closed(command));
                        restored = outcome.kind === "restored";
                      }
                      if (node?.hidden && node.origin === "created" && base) {
                        if (
                          !(await reveal(node, {
                            contextSourceId: locked.contextSourceId,
                            parentFolderId: locked.folderId,
                            name: locked.name,
                            extension: locked.extension,
                          }))
                        )
                          throw new ApplyClickRefused("forbidden");
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
                        ...(replaced ? { replaced } : {}),
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
                          live.transact(
                            () =>
                              writeBlocks(
                                live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
                                schema,
                                merged.blocks,
                              ),
                            "apply",
                          );
                          return {
                            before,
                            after: describeTrailBlocks(live, deps.model, codec, schema),
                          };
                        },
                      );
                      const seq = update
                        ? await deps.live.append(
                            command.documentId,
                            update,
                            { seq: 0, origin: `human:${command.envelope.accountId}` },
                            snapshot.authority,
                          )
                        : null;
                      await testHook("apply.afterLive");
                      const write = deps.coordinator.prepareAppend(base, [], {
                        authorServerRows(prefix) {
                          let row: Uint8Array | undefined;
                          const capture = (bytes: Uint8Array) => {
                            row = bytes;
                          };
                          prefix.on("update", capture);
                          try {
                            prefix.transact(() => {
                              const fragment = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
                              writeBlocks(
                                fragment,
                                schema,
                                applyBase(
                                  schema,
                                  readBlocks(fragment, schema),
                                  click.optimistic,
                                  click.patched,
                                ),
                              );
                              appendApplyRecord(prefix, click.record);
                            }, "apply");
                            if (!row) throw new Error("Apply must append its command record");
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
                        ...(overrode ? { overrode } : {}),
                        ...(restored ? { restored } : {}),
                        ...(replaced ? { replaced } : {}),
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

/** Where the branch has a document, as a live location to restore it at. */
function liveLocation(node: TreeStateNode) {
  return {
    contextSourceId: node.target.contextSourceId,
    parentFolderId: node.target.parentFolderId,
    name: node.target.name,
    extension: node.target.extension,
  };
}
