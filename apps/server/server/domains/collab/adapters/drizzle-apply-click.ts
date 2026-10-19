/** Atomic Apply: Work lock, command claim, committed live effect, prefix-authored base and trail. */
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
import type { ApplyClickAnswer, ApplyClickResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import {
  branchCommands,
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
import { dropDocumentRows } from "../../context/tree/branch-tree-store.js";
import { acquireEndUseScope, EndUseScopeChangedError } from "../../context/tree/end-use.js";
import { livingDocumentRefusal } from "../../context/tree/living-document.js";
import { place } from "../../context/tree/placement.js";
import { readRemovalRecords } from "../../context/tree/removal.js";
import { createTreeReader, type TreeStateNode } from "../../context/tree/tree-view.js";
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
import {
  persistDurableTrailRecords,
  preparedTrailChanges,
} from "../domain/draft-trail-projection.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { storedDocument } from "./document-loader.js";
import { claimCommandWithinTx, lookupCommand } from "./drizzle-branch-commands.js";

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
  async function closed(command: ApplyClickCommand): Promise<ApplyClickResult> {
    const removal = (await readRemovalRecords(currentDrizzleDb(db), [command.documentId])).get(
      command.documentId,
    );
    return {
      status: "closed",
      commandId: command.envelope.commandId,
      ...(removal ? { removal } : {}),
    };
  }
  async function reveal(node: TreeStateNode) {
    const placed = await place(db, {
      targets: [
        {
          node: { kind: "document", id: node.nodeId },
          at: {
            contextSourceId: node.target.contextSourceId,
            parentFolderId: node.target.parentFolderId,
            name: node.target.name,
            extension: node.target.extension,
          },
        },
      ],
    });
    if (!placed.ok) throw new ApplyClickRefused("forbidden");
    await deps.arrivals?.settle([node.nodeId]);
    await deps.catalog.refreshSources(
      placed.value.sourceIds,
      placed.value.placed.map((ref) => ref.id),
    );
  }
  return {
    closed,
    async loadBase(draftId) {
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
      const branchId =
        prepared.kind === "text" ? prepared.base.snapshot.branchId : prepared.branchId;
      const draftId = base?.snapshot.draftId;
      await testHook("apply.beforeBoundary");
      const boundaryStart = performance.now();
      let committedAt: number | undefined;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            return await applyTiming.run(
              { commandId: command.envelope.commandId, measured: deps.measured },
              () =>
                deps.workProjection.mutate(
                  { works: [command.workId] },
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
                    // Only a hidden-create reveal changes the tree. Ordinary text Apply must not
                    // serialize unrelated documents on their source's namespace lock.
                    const [initialNode] = await tree.treeState(branchId, [command.documentId]);
                    if (initialNode?.hidden)
                      await acquireEndUseScope(db, { documentIds: [command.documentId] });
                    else await lockDocumentMutation(tx, command.documentId);
                    if (draftId) {
                      const [row] = await tx
                        .select({ status: documentDrafts.status })
                        .from(documentDrafts)
                        .where(eq(documentDrafts.id, draftId));
                      if (!row || row.status === "closed") return finish(await closed(command));
                    }
                    const removed = await livingDocumentRefusal(tx, command.documentId);
                    if (removed)
                      return finish({
                        status: "closed",
                        commandId: command.envelope.commandId,
                        ...(removed.removal ? { removal: removed.removal } : {}),
                      });
                    if (!base || !click) {
                      const [node] = await tree.treeState(branchId, [command.documentId]);
                      const [draft] = await tx
                        .select({ id: documentDrafts.id })
                        .from(documentDrafts)
                        .where(
                          and(
                            eq(documentDrafts.branchId, branchId),
                            eq(documentDrafts.documentId, command.documentId),
                            eq(documentDrafts.status, "active"),
                          ),
                        );
                      if (!node?.hidden || node.origin !== "created" || draft)
                        return finish({
                          status: "refused",
                          commandId: command.envelope.commandId,
                          reason: "malformed",
                        });
                      await reveal(node);
                      await dropDocumentRows(db, { branchId, documentIds: [command.documentId] });
                      deferUntilDrizzleCommit(() => deps.onCommitted(command.documentId));
                      return finish({ status: "applied", commandId: command.envelope.commandId });
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
                      const [node] = await tree.treeState(branchId, [command.documentId]);
                      if (node?.hidden && node.origin === "created") {
                        await reveal(node);
                      }
                      if (node?.origin === "created")
                        await dropDocumentRows(db, {
                          branchId: branchId,
                          documentIds: [command.documentId],
                        });
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
                          draftGeneration: 1,
                          documentId: command.documentId,
                          journalIds: [],
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
                        ...(overrode ? { overrode } : {}),
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
            if (cause instanceof EndUseScopeChangedError && attempt < 3) continue;
            throw cause;
          }
        }
      } catch (cause) {
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
