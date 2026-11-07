/**
 * Agent-edit bindings over a thread's Work drafts: a call reads its Work draft's room copy, a
 * reply's save reconciles and appends its rows there. The thread peer is identity only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentEditJournal,
  type ConcurrentUpdateOrigin,
  type DocumentAccess,
  DocumentAccessLostError,
  type DocumentCoordinator,
  decodeSnapshot,
  frontierBlockId,
  frontierDelta,
  type JournalBatchAppendEntry,
  type StagedReconcile,
  type StagedRoomEntries,
  type StagedWriteSaveResult,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import type { DocumentRemovals } from "../../context/ports/document-removal.js";
import type { Branches } from "./branches.js";
import { partitionConcurrentUpdates } from "./concurrent-updates.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftJournalRow, DraftReplayJournalReads } from "./draft-journal.js";
import { peerLossReason, ThreadPeerPullLost, type WorkDraftLookup } from "./draft-pulls.js";
import type { DraftResolver, ResolvedDraft } from "./draft-resolver.js";
import { reconcileStagedDraftWrites } from "./draft-response-replay.js";
import {
  blockOriginsFromDraftSeed,
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
  liveJournal: Pick<UpdateJournal, "readUpdates">;
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

  return {
    async readRoom(docId, staged, access) {
      const peer = access?.pinnedDraftId;
      const read = async (workDraftId: string, bound: boolean) => {
        const { doc, snapshot, position } = await drafts.copyDraft(workDraftId);
        try {
          if (bound && snapshot.status !== "active")
            throw new DraftStaleUpdateError(`Draft ${workDraftId}`);
          const replay = staged
            ? await reconcile(workDraftId, doc, staged, peer)
            : { keptEntries: [], rejected: [] };
          return {
            doc,
            room: draftRoom(workDraftId),
            position,
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
        const blockOrigins = blockOriginsFromDraftSeed(
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
    async concurrentUpdatesForReport({
      docId,
      doc,
      baselineDoc,
      access,
      after,
      through,
      attributionBridge,
    }) {
      const projected = attributionBridge
        ? await projectedSeedChanges(input.liveJournal, docId, attributionBridge)
        : [];
      const rows = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        access,
        accessedPeer.getStore(),
        { after, through },
      );
      // `doc` is the save's cut, frozen: a row that landed after it is not reported.
      const cut = Y.snapshot(doc);
      return [
        ...projected,
        ...partitionConcurrentUpdates(
          baselineDoc ? Y.encodeStateAsUpdate(baselineDoc) : null,
          baselineDoc ? Y.snapshot(baselineDoc) : Y.emptySnapshot,
          rows
            .filter((row) => Y.snapshotContainsUpdate(cut, row.updateData))
            .map((row) => ({ origin: originForJournalRow(row), update: row.updateData })),
          Y.encodeStateAsUpdate(doc),
        ),
      ];
    },
  };
}

async function projectedSeedChanges(
  journal: Pick<UpdateJournal, "readUpdates">,
  docId: string,
  bridge: NonNullable<
    Parameters<
      NonNullable<DocumentCoordinator["concurrentUpdatesForReport"]>
    >[0]["attributionBridge"]
  >,
) {
  if (!bridge.sourceCut) {
    return bridge.unattributedTargets?.length
      ? [
          {
            update: new Uint8Array(),
            origin: { type: "unattributed" as const },
            effects: { changed: bridge.unattributedTargets, removed: [] },
          },
        ]
      : [];
  }
  const seed = new Y.Doc({ gc: false });
  Y.applyUpdate(seed, bridge.sourceCut.state);
  const snapshot = decodeSnapshot(bridge.sourceSnapshot);
  if (!snapshot) return [];
  const baseline = Y.createDocFromSnapshot(seed, snapshot, new Y.Doc({ gc: false }));
  try {
    const rows = (
      await journal.readUpdates(docId, bridge.sourceCut.after, bridge.sourceCut.through)
    ).map((entry) => ({
      update: entry.update,
      origin: entry.meta.origin.startsWith("agent:")
        ? {
            type: "agent" as const,
            actorTurnId: entry.meta.actorTurnId ?? entry.meta.origin.slice("agent:".length),
            ...(entry.meta.author ? { author: entry.meta.author } : {}),
          }
        : entry.meta.origin.startsWith("human:")
          ? {
              type: "human" as const,
              userId: entry.meta.origin.slice("human:".length),
            }
          : { type: "unattributed" as const },
    }));
    const updates = partitionConcurrentUpdates(
      Y.encodeStateAsUpdate(baseline),
      Y.snapshot(baseline),
      rows,
      bridge.sourceCut.state,
    );
    return updates.flatMap((row) => {
      const before = {
        room: bridge.sourceRoom,
        snapshot: Y.encodeSnapshotV2(Y.snapshot(baseline)),
      };
      Y.applyUpdate(baseline, row.update);
      const effect = frontierDelta(baseline, before);
      const changed = effect.changed.flatMap((id) => {
        const target = bridge.targetBySource[id];
        return target ? [target] : [];
      });
      const removed = effect.removed
        .map(frontierBlockId)
        .map((id) => bridge.targetBySource[id] ?? id);
      return changed.length || removed.length
        ? [{ update: new Uint8Array(), origin: row.origin, effects: { changed, removed } }]
        : [];
    });
  } finally {
    baseline.destroy();
    seed.destroy();
  }
}

/**
 * The draft core's journal: ordinals and attribution come from live; a drafted write's rows
 * append through its save, never here.
 */
export function createDraftAgentEditJournal(input: {
  liveJournal: UpdateJournal;
}): AgentEditJournal {
  return {
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
  bounds?: { after: number; through: number },
): Promise<DraftJournalRow[]> {
  const workDraftId = access?.workDraftId;
  if (workDraftId)
    return input.draftCoordinator.readDraft(workDraftId, (_doc, _snapshot) =>
      input.journalRows.listConcurrentJournalRows(workDraftId, {
        documentId,
        after: bounds?.after ?? 0,
        through: bounds?.through ?? Number.MAX_SAFE_INTEGER,
      }),
    );
  // A pinned or running access names the peer; only a legacy free-standing read resolves it.
  const peerId =
    access?.pinnedDraftId ??
    accessedPeer ??
    (await input.drafts.resolveThreadDraft(documentId, input.threadId)).draftId;
  const upstreamDraftId = (await input.drafts.getDraft(peerId))?.upstreamDraftId;
  if (!upstreamDraftId) return [];
  return input.draftCoordinator.readDraft(upstreamDraftId, (_doc, _snapshot) =>
    input.journalRows.listConcurrentJournalRows(upstreamDraftId, {
      documentId,
      after: bounds?.after ?? 0,
      through: bounds?.through ?? Number.MAX_SAFE_INTEGER,
    }),
  );
}

function originForJournalRow(row: DraftJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return {
      type: "agent" as const,
      actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent",
      ...(row.threadHandle ? { author: `agent (${row.threadHandle})` } : {}),
    };
  }
  if (row.source === "writer")
    return { type: "human" as const, userId: row.actorUserId ?? "unknown" };
  return { type: "unattributed" as const };
}
