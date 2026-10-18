/** Selective Discard re-forks a Work draft from live and its surviving journal rows. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  BranchPushCommitConflictError,
  DraftChangeRefusal,
  type DraftReviewService,
  type PushCommitStore,
} from "./branch-push-contracts.js";
import { assertNoPendingIntegration } from "./branch-push-plan.js";
import { documentEffectsEqual } from "./document-content.js";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./draft-attempts.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftJournalReadStore, DraftJournalRow } from "./draft-journal.js";
import type { DraftSnapshot, DraftStore } from "./draft-store.js";

type Dependencies = {
  draftStore: DraftStore;
  journalReadStore: DraftJournalReadStore;
  commitStore: PushCommitStore;
  draftCoordinator?: Partial<Pick<DraftCoordinator, "notifyReset">>;
  journal: UpdateJournal;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
};

export function createDraftReviewOperations(deps: Dependencies): DraftReviewService {
  async function listReviewableRows(
    draftId: string,
    generation: number,
  ): Promise<DraftJournalRow[]> {
    return deps.journalReadStore.listReviewableJournalRows(draftId, generation);
  }

  async function loadLiveDoc(documentId: DraftSnapshot["documentId"]): Promise<Y.Doc> {
    const snapshot = await deps.journal.read(documentId);
    const doc = createCollabYDoc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }

  /**
   * Attempts that re-read the drafts and run again when a writer's frame or another
   * process moved one under us. Four attempts each finding the draft moved (a writer typing)
   * answer stale, as a selection made against an older draft does.
   */
  async function withActiveWorkDrafts<T>(
    draftIds: readonly string[],
    run: (drafts: readonly DraftSnapshot[], attempt: Attempt) => Promise<T>,
  ): Promise<T> {
    if (draftIds.length === 0) throw new Error("A selected Discard names a branch");
    return runBoundedAttempts({
      bound: DISCARD_ATTEMPTS,
      scope: deps.attemptScope ?? NO_ATTEMPT_SCOPE,
      isMiss: (cause) => cause instanceof BranchPushCommitConflictError,
      run: async (attempt) => {
        const drafts = await Promise.all(
          draftIds.map(async (draftId) =>
            assertActiveWorkDraft(await deps.draftStore.getDraft(draftId), draftId),
          ),
        );
        return run(drafts, attempt);
      },
      exhausted: () => {
        throw new DraftChangeRefusal("stale");
      },
    });
  }

  async function discardSelected(
    discardInput: Parameters<DraftReviewService["discardSelected"]>[0],
  ): ReturnType<DraftReviewService["discardSelected"]> {
    return withActiveWorkDrafts([discardInput.draftId], async ([documentDraft], attempt) => {
      const reviewableRows = await listReviewableRows(
        documentDraft.draftId,
        documentDraft.generation,
      );
      const selection = await discardInput.selectRows(documentDraft, reviewableRows);
      const selected = new Set(selection.journalIds);
      if (selected.size === 0) throw new Error("selective_discard_requires_rows");
      const rows = reviewableRows.filter((row) => selected.has(row.id));
      if (rows.length !== selected.size) {
        return {
          status: "nothing_to_undo" as const,
          draftId: documentDraft.draftId,
          journalIds: [...selected].sort((a, b) => a - b),
        };
      }
      const history = await deps.journalReadStore.listJournalRowsForDraft({
        draftId: documentDraft.draftId,
        generation: documentDraft.generation,
      });
      const survivors = history.filter(
        (row) => row.status !== "discarded" && !selected.has(row.id),
      );
      const peer = await loadLiveDoc(documentDraft.documentId);
      const live = new Y.Doc({ gc: false });
      Y.applyUpdate(live, Y.encodeStateAsUpdate(peer));
      try {
        for (const row of survivors) Y.applyUpdate(peer, row.updateData);
        assertNoPendingIntegration(
          peer,
          "selective_discard_refork",
          survivors.map((row) => row.id),
        );
        const itemClosed = documentEffectsEqual(live, peer);
        const itemDisposition = history.some((row) => row.status === "pushed")
          ? ("applied" as const)
          : ("discarded" as const);
        const outcome = { itemClosed, ...(itemClosed ? { itemDisposition } : {}) };
        // Computed above off every lock; the re-fork's one commit scope.
        await attempt.commit(() =>
          deps.commitStore.commitDiscard({
            ...(discardInput.command
              ? {
                  command: {
                    envelope: discardInput.command.envelope,
                    result: discardInput.command.result(outcome),
                  },
                }
              : {}),
            documentDraft,
            journalRows: rows,
            survivors,
            retireSurvivors: itemClosed,
            expectedLiveRevision: selection.expectedLiveRevision,
            state: Y.encodeStateAsUpdate(itemClosed ? live : peer),
            reviewedByUserId: discardInput.reviewedByUserId,
          }),
        );
        attempt.own({
          transfer: () =>
            deps.draftCoordinator?.notifyReset?.({
              draftId: documentDraft.draftId,
              generation: documentDraft.generation + 1,
            }),
          dispose() {},
        });
        return {
          status: "discarded",
          draftId: documentDraft.draftId,
          journalIds: [...selected].sort((a, b) => a - b),
          ...outcome,
        };
      } finally {
        live.destroy();
        peer.destroy();
      }
    });
  }

  return {
    discardSelected,
  };
}

const DISCARD_ATTEMPTS = 4;

function assertActiveWorkDraft(
  documentDraft: DraftSnapshot | null | undefined,
  draftId: string,
): DraftSnapshot {
  if (!documentDraft) throw new Error(`Draft ${draftId} does not exist`);
  if (documentDraft.kind !== "work_draft" || documentDraft.status !== "active") {
    throw new Error(`Draft ${draftId} is not an active work draft`);
  }
  return documentDraft;
}
