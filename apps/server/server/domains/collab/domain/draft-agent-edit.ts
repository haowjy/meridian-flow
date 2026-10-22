/**
 * Agent-edit bindings over a thread's Work drafts: a call reads its Work draft's room copy, a
 * reply's save reconciles and appends its rows there. The thread peer is identity only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentEditJournal,
  bindBlockOrigins,
  bytesEqual,
  type ConcurrentUpdate,
  type ConcurrentUpdateOrigin,
  cloneYDoc,
  type DocumentAccess,
  DocumentAccessLostError,
  type DocumentCoordinator,
  type JournalBatchAppendEntry,
  type JournalReadOptions,
  type JournalSnapshot,
  type StagedReconcile,
  type StagedRoomEntries,
  type StagedWriteSaveResult,
  type UpdateJournal,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import type { DocumentRemovals } from "../../context/ports/document-removal.js";
import type { Branches } from "./branches.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftJournalRow, DraftReplayJournalReads } from "./draft-journal.js";
import { peerLossReason, ThreadPeerPullLost, type WorkDraftLookup } from "./draft-pulls.js";
import type { DraftResolver, ResolvedDraft } from "./draft-resolver.js";
import { reconcileStagedDraftWrites } from "./draft-response-replay.js";
import {
  DraftCasConflictError,
  DraftMissingError,
  type DraftSnapshot,
  DraftStaleUpdateError,
} from "./draft-store.js";
import { draftRoom } from "./observation-rooms.js";
import type { ReplyPin } from "./reply-save-fences.js";

export type DraftAgentEditDiagnostics = {
  replyPinMismatch(payload: { documentId: DocumentId; threadId?: ThreadId; pin: ReplyPin }): void;
};

export function createDraftAgentEditCoordinator(input: {
  removals: DocumentRemovals;
  threadId: ThreadId;
  draftCoordinator: DraftCoordinator;
  drafts: DraftLookupWithSnapshots;
  journalRows: DraftReplayJournalReads;
  /** The live→Work rebase at the tool boundary: every room read runs it first. */
  flushLivePull(documentId: DocumentId): Promise<void>;
  branches: Pick<Branches, "shareActive">;
}): DocumentCoordinator {
  function draftRows(draftId: string, entries: readonly JournalBatchAppendEntry[]) {
    return entries.flatMap((entry) => {
      const mutation = entry.mutation;
      if (mutation?.mode !== "threadPeer") throw new Error("thread_peer_commit_missing_identity");
      return (mutation.editParts ?? [entry.update]).map((updateData) => ({
        draftId,
        source: "agent" as const,
        updateData,
        documentEditKey: mutation.writeId,
        threadId: (mutation.threadId as ThreadId | undefined) ?? input.threadId,
        turnId: mutation.turnId ?? null,
        wId: mutation.wId ?? null,
        toolCallId: mutation.toolCallId ?? null,
        updateMeta: entry.meta ?? null,
        ...(mutation.semanticEditIr ? { semanticEditIr: mutation.semanticEditIr } : {}),
      }));
    });
  }
  const drafts = input.draftCoordinator;
  /** The peer of the access running now: attribution inside it resolves no other identity. */
  const accessedPeer = new AsyncLocalStorage<string>();

  /**
   * Entries an earlier peer of this scope accepted, when that peer has since closed: a Discard
   * took them, and its retirement will say so. Until it does, no view shows them and no save
   * keeps them; each is refused now with the Discard's reason.
   */
  async function retiredPeerEntries(
    entries: readonly JournalBatchAppendEntry[],
    peerDraftId: string | undefined,
  ): Promise<Map<string, StagedReconcile["rejected"][number]["reason"]>> {
    const refused = new Map<string, StagedReconcile["rejected"][number]["reason"]>();
    const checked = new Map<string, Awaited<ReturnType<typeof peerLossReason>> | null>();
    for (const entry of entries) {
      const mutation = entry.mutation;
      const accepted = mutation?.mode === "threadPeer" ? mutation.peerDraftId : undefined;
      if (!mutation?.writeId || !accepted || !peerDraftId || accepted === peerDraftId) continue;
      if (!checked.has(accepted)) {
        const old = await input.drafts.getDraft(accepted);
        checked.set(
          accepted,
          old && old.status !== "closed"
            ? null
            : ((await peerLossReason(
                input,
                new ThreadPeerPullLost(accepted, old?.upstreamDraftId ?? "", null),
                old?.branchId,
              )) ?? "discarded_edit"),
        );
      }
      const reason = checked.get(accepted);
      if (reason) refused.set(mutation.writeId, reason);
    }
    return refused;
  }

  async function reconcile(
    draftId: string,
    doc: Y.Doc,
    staged: StagedRoomEntries,
    peerDraftId: string | undefined,
  ): Promise<{ keptEntries: JournalBatchAppendEntry[] } & Pick<StagedReconcile, "rejected">> {
    const refused = await retiredPeerEntries(staged.entries, peerDraftId);
    const entries = staged.entries.filter((entry) => !refused.has(entry.mutation?.writeId ?? ""));
    const cut = Y.decodeSnapshotV2(staged.cut.snapshot);
    const inverses: Uint8Array[] = [];
    for (const row of await input.journalRows.listJournalRowsForDraft({ draftId })) {
      if (
        !Y.snapshotContainsUpdate(cut, row.updateData) &&
        row.editKind &&
        row.editKind !== "write"
      )
        inverses.push(row.updateData);
    }
    const replay = reconcileStagedDraftWrites(doc, entries, cut, inverses);
    return {
      keptEntries: replay.keptEntries,
      rejected: [
        ...[...refused].map(([writeId, reason]) => ({ writeId, reason })),
        ...replay.rejectedWrites,
      ],
    };
  }

  /**
   * `run` as an access to the peer a call is bound to, on its Work draft: a Discard that closed
   * the peer, its Work draft or the branch since the ensure is `DocumentAccessLostError` naming
   * that Discard (else `ThreadPeerPullLost`). It acquires nothing: a save or a close racing it
   * is ordered by the revisions its writes were prepared at.
   */
  async function underAccess<T>(
    peerDraftId: string,
    run: (workDraftId: string) => Promise<T>,
  ): Promise<T> {
    await testHook("draft.beforeAccess");
    let upstreamDraftId = "";
    let branchId: BranchId | undefined;
    try {
      const peer = await input.drafts.getDraft(peerDraftId);
      upstreamDraftId = peer?.upstreamDraftId ?? "";
      branchId = peer?.branchId;
      if (!peer) throw new DraftMissingError(peerDraftId);
      if (peer.status === "closed") throw new DraftStaleUpdateError(`Draft ${peerDraftId}`);
      if (!upstreamDraftId) throw new Error(`Thread peer ${peerDraftId} has no Work draft`);
      return await accessedPeer.run(peerDraftId, () => run(upstreamDraftId));
    } catch (cause) {
      if (
        cause instanceof DraftStaleUpdateError ||
        cause instanceof DraftCasConflictError ||
        cause instanceof DraftMissingError
      ) {
        // A Discard's loss is the write's named refusal, not a failure.
        const lost = new ThreadPeerPullLost(peerDraftId, upstreamDraftId, cause);
        const reason = await peerLossReason(input, lost, branchId);
        throw reason ? new DocumentAccessLostError(reason, { cause: lost }) : lost;
      }
      throw cause;
    }
  }

  /** The thread's Work draft a call bound to no peer reads (a read never ensures one). */
  async function threadWorkDraft(documentId: DocumentId): Promise<ResolvedDraft> {
    return input.drafts.resolveWorkDraftForThread(documentId, input.threadId);
  }

  function bindSeedAddresses(doc: Y.Doc, snapshot: DraftSnapshot): void {
    const origins = seedAddresses(snapshot.seed);
    if (origins) bindBlockOrigins(doc, origins);
  }

  return {
    async readRoom(docId, staged, access) {
      const peer = access?.pinnedDraftId;
      const read = async (workDraftId: string, bound: boolean) => {
        const { doc, snapshot } = await drafts.copyDraft(workDraftId);
        try {
          bindSeedAddresses(doc, snapshot);
          if (bound && snapshot.status !== "active")
            throw new DraftStaleUpdateError(`Draft ${workDraftId}`);
          const replay = staged
            ? await reconcile(workDraftId, doc, staged, peer)
            : { keptEntries: [], rejected: [] };
          return {
            doc,
            room: draftRoom(workDraftId),
            kept: replay.keptEntries.flatMap((entry) =>
              entry.mutation?.writeId ? [entry.mutation.writeId] : [],
            ),
            rejected: replay.rejected,
          };
        } catch (cause) {
          doc.destroy();
          throw cause;
        }
      };
      await input.flushLivePull(docId as DocumentId);
      return peer
        ? underAccess(peer, (workDraftId) => read(workDraftId, true))
        : read(access?.workDraftId ?? (await threadWorkDraft(docId as DocumentId)).draftId, false);
    },

    async prepareSave({
      docId,
      cut,
      entries,
      access,
      precondition,
    }): Promise<StagedWriteSaveResult> {
      const peerId =
        access?.pinnedDraftId ?? (await resolveThreadDraftId(input, docId as DocumentId));
      return underAccess(peerId, async (workDraftId) => {
        const blockOrigins = seedAddresses(
          (await input.drafts.getDraft(workDraftId))?.seed ?? null,
        );
        const { result, write } = await drafts.prepareStagedRows(
          workDraftId,
          async (doc) => {
            const replay = await reconcile(workDraftId, doc, { cut, entries }, peerId);
            return {
              result: {
                kept: replay.keptEntries.flatMap((entry) =>
                  entry.mutation?.writeId ? [entry.mutation.writeId] : [],
                ),
                rejected: replay.rejected,
                room: draftRoom(workDraftId),
              },
              rows: draftRows(workDraftId, replay.keptEntries),
            };
          },
          true,
          precondition,
        );
        if (!write)
          return {
            ...result,
            ...(blockOrigins ? { blockOrigins } : {}),
            write: { kind: "no-effect" },
          };
        return {
          ...result,
          ...(blockOrigins ? { blockOrigins } : {}),
          write: {
            kind: "write",
            async persist() {
              await write.persist();
              return write.cut();
            },
            // Installing the replica waits for the enclosing root commit: the coordinator defers it.
            transfer: () => write.transfer(),
            dispose: () => write.dispose(),
          },
        };
      });
    },

    /**
     * The Work draft's rows (and anything the journal can't explain, as the writer's) that the
     * baseline, the view the writes planned on, doesn't contain: containment is the only skip.
     */
    async concurrentUpdatesSince({ docId, doc, baselineDoc, access }) {
      const rows = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        access,
        accessedPeer.getStore(),
      );
      // `doc` is the save's cut, frozen: a row that landed after it is not reported.
      const cut = Y.snapshot(doc);
      return partitionConcurrentUpdates(
        baselineDoc ? Y.encodeStateAsUpdate(baselineDoc) : null,
        baselineDoc ? Y.snapshot(baselineDoc) : Y.emptySnapshot,
        rows
          .filter((row) => Y.snapshotContainsUpdate(cut, row.updateData))
          .map((row) => ({ origin: originForJournalRow(row), update: row.updateData })),
        Y.encodeStateAsUpdate(doc),
      );
    },
  };
}

function parseItemId(value: string): { clientID: number; clock: number } {
  const [clientID, clock, extra] = value.split(":").map(Number);
  if (!Number.isSafeInteger(clientID) || !Number.isSafeInteger(clock) || extra !== undefined)
    throw new Error(`Invalid block item id ${value}`);
  return { clientID, clock };
}

function seedAddresses(
  seed: DraftSnapshot["seed"],
): Map<string, { clientID: number; clock: number }> | null {
  return seed
    ? new Map(Object.entries(seed.origins).map(([target, origin]) => [target, parseItemId(origin)]))
    : null;
}

/**
 * The draft core's journal: ordinals and attribution come from live; a drafted write's rows
 * append through its save, never here.
 */
export function createDraftAgentEditJournal(input: {
  liveJournal: UpdateJournal;
}): AgentEditJournal {
  const materializeDestructiveProvenance = input.liveJournal.materializeDestructiveProvenance?.bind(
    input.liveJournal,
  );
  return {
    read(_docId: string, _opts?: JournalReadOptions): Promise<JournalSnapshot> {
      return Promise.resolve({ checkpoint: null, updates: [] });
    },

    readAttribution(docId: string): Promise<JournalSnapshot> {
      return input.liveJournal.readAttribution?.(docId) ?? input.liveJournal.read(docId);
    },

    ...(materializeDestructiveProvenance
      ? {
          materializeDestructiveProvenance: (request) =>
            materializeDestructiveProvenance({
              ...request,
              // Roots absent from the live document were born on this agent-owned draft.
              fallbackProvenance: "agent",
            }),
        }
      : {}),

    reserveWriteOrdinal(documentId, threadId) {
      return input.liveJournal.reserveWriteOrdinal(documentId, threadId);
    },
  };
}

export type DraftLookupWithSnapshots = WorkDraftLookup &
  DraftResolver & {
    getDraft(
      draftId: string,
    ): Promise<Pick<
      DraftSnapshot,
      "upstreamDraftId" | "branchId" | "status" | "closedCause" | "documentId" | "seed"
    > | null>;
    /** The thread's primary Work's active draft on the document, as metadata. */
    resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
  };

/**
 * The thread's current peer of the document. A peer is made only by the write path's ensure:
 * an access that finds none is `DraftNotFoundError`, never a new peer draft.
 */
async function resolveThreadDraftId(
  input: { threadId: ThreadId; drafts: DraftLookupWithSnapshots },
  documentId: DocumentId,
): Promise<string> {
  return (await input.drafts.resolveThreadDraft(documentId, input.threadId)).draftId;
}

/** The upstream draft's journal rows. */
async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    draftCoordinator: DraftCoordinator;
    drafts: DraftLookupWithSnapshots;
    journalRows: DraftReplayJournalReads;
  },
  documentId: DocumentId,
  access?: DocumentAccess,
  accessedPeer?: string,
): Promise<DraftJournalRow[]> {
  // A pinned or running access names the peer; only a free-standing read resolves it.
  const peerId =
    access?.pinnedDraftId ??
    accessedPeer ??
    (await input.drafts.resolveThreadDraft(documentId, input.threadId)).draftId;
  const upstreamDraftId = (await input.drafts.getDraft(peerId))?.upstreamDraftId;
  if (!upstreamDraftId) return [];
  return input.draftCoordinator.readDraft(upstreamDraftId, (_doc, _snapshot) =>
    input.journalRows.listConcurrentJournalRows(upstreamDraftId, {
      documentId,
    }),
  );
}

function originForJournalRow(row: DraftJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return { type: "agent" as const, actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent" };
  }
  return { type: "human" as const, userId: row.actorUserId ?? "unknown" };
}

/**
 * Each row's effect on the baseline in order, then the residual the journal can't explain,
 * attributed to the writer.
 */
function partitionConcurrentUpdates(
  baselineState: Uint8Array | null,
  baselineSnapshot: Y.Snapshot,
  journalRows: readonly ConcurrentUpdate[],
  upstreamState: Uint8Array,
): ConcurrentUpdate[] {
  // A state vector alone misses delete-only edits: compare structs and tombstones.
  const rows = journalRows.filter((row) => !Y.snapshotContainsUpdate(baselineSnapshot, row.update));
  if (rows.length === 0 && baselineState && bytesEqual(baselineState, upstreamState)) return [];
  const scratch = new Y.Doc({ gc: false });
  if (baselineState && baselineState.byteLength > 0) Y.applyUpdate(scratch, baselineState);
  try {
    const updates: ConcurrentUpdate[] = [];
    for (const row of rows) {
      const update = effectiveUpdateFromApplyingToScratch(scratch, row.update);
      if (update) updates.push({ update, origin: row.origin });
    }
    const target = yjsUpdateFromState(upstreamState);
    try {
      const residual = yjsDeltaUpdate(target, scratch);
      if (residual)
        updates.push({ update: residual, origin: { type: "human", userId: "unknown" } });
    } finally {
      target.destroy();
    }
    return updates;
  } finally {
    scratch.destroy();
  }
}

function effectiveUpdateFromApplyingToScratch(
  scratch: Y.Doc,
  update: Uint8Array,
): Uint8Array | null {
  const probe = cloneYDoc(scratch);
  try {
    Y.applyUpdate(probe, update);
    const effective = yjsDeltaUpdate(probe, scratch);
    if (!effective) return null;
    Y.applyUpdate(scratch, effective);
    return effective;
  } finally {
    probe.destroy();
  }
}
