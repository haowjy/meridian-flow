/**
 * Agent-edit bindings over a thread's Work drafts: a call reads its Work draft's room copy and
 * a model edit saves its rows there.
 */

import {
  type AgentEditJournal,
  type ConcurrentUpdateOrigin,
  type DocumentCoordinator,
  decodeSnapshot,
  frontierBlockId,
  frontierDelta,
  type JournalBatchAppendEntry,
  type PreparedSave,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { partitionConcurrentUpdates } from "./concurrent-updates.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftJournalRow, DraftReplayJournalReads } from "./draft-journal.js";
import type { WorkDraftLookup } from "./draft-pulls.js";
import type { ResolvedDraft } from "./draft-resolver.js";
import { blockOriginsFromDraftSeed, type DraftSnapshot } from "./draft-store.js";
import { inLockedWrite } from "./locked-write.js";
import { draftRoom } from "./observation-rooms.js";

export function createDraftAgentEditCoordinator(input: {
  threadId: ThreadId;
  draftCoordinator: DraftCoordinator;
  drafts: DraftLookupWithSnapshots;
  journalRows: DraftReplayJournalReads;
  liveJournal: Pick<UpdateJournal, "readUpdates">;
  /** The live→Work rebase at the tool boundary: every room read runs it first. */
  flushLivePull(documentId: DocumentId): Promise<void>;
}): DocumentCoordinator {
  function rowsFor(draftId: string, entries: readonly JournalBatchAppendEntry[]) {
    return entries.flatMap((entry) => {
      const mutation = entry.mutation;
      if (!mutation) throw new Error("A draft write carries its mutation");
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

  /** The thread's Work draft a call bound to none reads (a read never ensures one). */
  async function threadWorkDraft(documentId: DocumentId): Promise<ResolvedDraft> {
    return input.drafts.resolveWorkDraftForThread(documentId, input.threadId);
  }

  return {
    async readRoom(docId, access) {
      // A model edit read under its lock pulled before it took it (a pull opens its own connection).
      if (!inLockedWrite()) await input.flushLivePull(docId as DocumentId);
      const workDraftId =
        access?.workDraftId ?? (await threadWorkDraft(docId as DocumentId)).draftId;
      const { doc, position } = await drafts.copyDraft(workDraftId);
      return { doc, room: draftRoom(workDraftId), position };
    },

    /**
     * A model edit's save, straight to the Work draft its host ensured and locked: the plan was
     * made under the append's lock, so nothing can retire it before.
     */
    async prepareSave({ entries, access, precondition }): Promise<PreparedSave> {
      const workDraftId = access?.workDraftId;
      if (!workDraftId) throw new Error("A drafted save names its Work draft");
      const blockOrigins = blockOriginsFromDraftSeed(
        (await input.drafts.getDraft(workDraftId))?.seed ?? null,
      );
      const { write } = await drafts.prepareStagedRows(
        workDraftId,
        async (doc) => {
          for (const entry of entries) Y.applyUpdate(doc, entry.update);
          return { result: undefined, rows: rowsFor(workDraftId, entries) };
        },
        true,
        precondition,
      );
      return {
        room: draftRoom(workDraftId),
        ...(blockOrigins ? { blockOrigins } : {}),
        write: write
          ? {
              kind: "write",
              async persist() {
                await write.persist();
                return write.cut();
              },
              transfer: () => write.transfer(),
              dispose: () => write.dispose(),
            }
          : { kind: "no-effect" },
      };
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
      const workDraftId =
        access?.workDraftId ?? (await threadWorkDraft(docId as DocumentId)).draftId;
      const rows = await input.draftCoordinator.readDraft(workDraftId, () =>
        input.journalRows.listConcurrentJournalRows(workDraftId, {
          documentId: docId as DocumentId,
          after,
          through,
        }),
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

export type DraftLookupWithSnapshots = WorkDraftLookup & {
  getDraft(
    draftId: string,
  ): Promise<Pick<
    DraftSnapshot,
    "upstreamDraftId" | "branchId" | "status" | "closedCause" | "documentId" | "seed"
  > | null>;
  /** The thread's primary Work's active draft on the document, as metadata. */
  resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
};

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
