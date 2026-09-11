/**
 * useThreadHandoff — starts the chat stream that belongs to this thread mount.
 *
 * The hook owns both durable project first-send admission and snapshot-based
 * reload resume. Keeping them in one place prevents two controller runs from
 * subscribing to the same active thread during mount.
 */

import type { ThreadLiveState } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createProject } from "@/client/api/projects-api";
import { createThread } from "@/client/api/threads-api";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { useFirstSendContinuity } from "@/client/first-send-continuity";
import {
  invalidateProjectThreadData,
  invalidateWorkThreads,
} from "@/client/query/project-invalidation";
import type { ThreadStoreActions } from "@/client/stores";
import { announceError } from "@/client/stores";
import type { ComposerDraftSnapshot } from "@/components/app/composer";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { threadCreateAgentField } from "@/features/agents/constants";

type Controller = ThreadRunController;

type SnapshotResumeState = {
  liveState: ThreadLiveState | null;
  /** Snapshot stream head; retained for non-active diagnostics, not active-run resume. */
  nextSeq: string | null;
};

function isActiveSnapshot(liveState: ThreadLiveState): boolean {
  return liveState.runningTurnId !== null || liveState.status === "active";
}

export function activeSnapshotResumeAfterSeq(liveState: ThreadLiveState): string | null {
  if (!isActiveSnapshot(liveState)) return null;
  try {
    const resumeAfter = BigInt(liveState.resumeAfterSeq);
    if (resumeAfter < 0n) return null;
    return resumeAfter.toString();
  } catch {
    return null;
  }
}

/**
 * Consumes {@link ThreadStoreActions.consumePendingStream} once per mount: resumes
 * an in-flight run or claims a durable first-send admission or retained standalone creation.
 */
export function useThreadHandoff(
  threadId: string,
  projectId: string | null,
  controller: Controller,
  actions: ThreadStoreActions,
  snapshotResume?: SnapshotResumeState,
  restoreLatestDraft?: (snapshot: ComposerDraftSnapshot, expectedRevision: number) => number | null,
  restoreFailedSubmission?: (
    id: string,
    submitted: ComposerDraftSnapshot,
    later: ComposerDraftSnapshot | null | undefined,
    expectedRevision: number,
  ) => number | null,
): void {
  const pendingResumeRef = useRef(false);
  const handoffStartedRef = useRef(false);
  const snapshotEvaluatedRef = useRef(false);
  const continuityStartedRef = useRef(false);
  const [continuityChecked, setContinuityChecked] = useState(projectId === null);
  const queryClient = useQueryClient();
  const continuity = useFirstSendContinuity();

  useEffect(() => {
    pendingResumeRef.current = false;
    handoffStartedRef.current = false;
    snapshotEvaluatedRef.current = false;
    continuityStartedRef.current = false;
    setContinuityChecked(projectId === null);
  }, [projectId, threadId]);

  useEffect(() => {
    if (!projectId || continuityStartedRef.current) return;
    continuityStartedRef.current = true;
    let mounted = true;
    void continuity
      .findForThread(projectId, threadId)
      .then(async (claim) => {
        if (!claim || !mounted) return;
        handoffStartedRef.current = true;
        const { record } = claim;
        const key = { projectId: record.projectId, threadId, submissionId: record.submissionId };
        let destinationRevision: number | null = 0;
        if (record.latestDraft)
          destinationRevision =
            restoreLatestDraft?.(record.latestDraft, destinationRevision) ?? null;
        let restoredStamp = JSON.stringify([record.latestDraft, record.creation?.draftRevision]);
        const outcome = claim.dispatch
          ? await controller.submit(threadId, record.envelope, {
              optimisticUserTurnId: record.optimisticUserTurnId,
            })
          : await controller.lookup(threadId, record.envelope, {
              optimisticUserTurnId: record.optimisticUserTurnId,
            });
        if (outcome.kind === "ambiguous") {
          await continuity.markAmbiguous(key);
          return;
        }
        // Admission and creation acknowledgement retire together, only after the
        // destination has restored the latest revision observed in that transaction.
        let observed = await continuity.peek(key);
        while (mounted && observed) {
          if (destinationRevision === null) return;
          const stamp = JSON.stringify([observed.latestDraft, observed.creation?.draftRevision]);
          if (outcome.kind === "accepted") {
            if (stamp !== restoredStamp) {
              const draft =
                observed.latestDraft ?? serializeComposerDraft(plainComposerDoc("")).draft;
              destinationRevision = restoreLatestDraft?.(draft, destinationRevision) ?? null;
            }
          } else {
            destinationRevision =
              restoreFailedSubmission?.(
                `${threadId}:${record.submissionId}:${observed.creation?.draftRevision ?? observed.latestDraft?.revision ?? "submitted"}`,
                record.envelope.draft,
                observed.latestDraft,
                destinationRevision,
              ) ?? null;
          }
          if (destinationRevision === null || (await continuity.retire(observed))) return;
          restoredStamp = stamp;
          observed = await continuity.peek(key);
        }
      })
      .catch((error) =>
        announceError(error instanceof Error ? error.message : "Failed to reconcile submission"),
      )
      .finally(() => {
        if (mounted) setContinuityChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, [continuity, controller, projectId, restoreFailedSubmission, restoreLatestDraft, threadId]);

  useEffect(() => {
    if (!continuityChecked) return;
    const startResume = (after?: string, expectedTurnId?: string) => {
      try {
        controller.resume(threadId, { after, expectedTurnId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to resume stream";
        announceError(message);
      } finally {
        pendingResumeRef.current = false;
      }
    };

    const startSubmit = (text: string, optimisticUserTurnId?: string) => {
      const envelope = serializeComposerDraft(plainComposerDoc(text));
      void controller
        .submit(threadId, envelope, { optimisticUserTurnId })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Failed to start stream";
          announceError(message);
        })
        .finally(() => {
          pendingResumeRef.current = false;
        });
    };

    const pendingStream = actions.consumePendingStream(threadId);
    if (pendingStream) {
      if (pendingResumeRef.current) return;
      pendingResumeRef.current = true;
      handoffStartedRef.current = true;

      if (pendingStream.independentCreation) {
        const { projectId, title, text, optimisticUserTurnId, currentAgent } =
          pendingStream.independentCreation;
        void (async () => {
          try {
            await createProject({ id: projectId, title });
            const thread = await createThread({
              data: {
                id: threadId,
                projectId,
                title,
                ...threadCreateAgentField(currentAgent),
              },
            });
            actions.ensureThread(thread);
            // Server confirmation arrived: gated queries can now fire safely.
            actions.clearPendingCreation({ projectId, threadId });
            await Promise.all([
              invalidateProjectThreadData(queryClient, projectId),
              ...(thread.workId
                ? [invalidateWorkThreads(queryClient, projectId, thread.workId)]
                : []),
            ]);
            if (text) {
              startSubmit(text, optimisticUserTurnId);
            } else {
              // No first message (package-card flow); project + thread now exist
              // on the server. The composer is waiting for the user.
              pendingResumeRef.current = false;
            }
          } catch (error) {
            // Leave pending-creation set on failure so retries through this
            // mount remain gated until the next successful confirmation.
            const message = error instanceof Error ? error.message : "Failed to start conversation";
            announceError(message);
            pendingResumeRef.current = false;
          }
        })();
        return;
      }

      startResume(pendingStream.after, pendingStream.expectedTurnId);
      return;
    }

    if (snapshotEvaluatedRef.current || handoffStartedRef.current) return;
    const liveState = snapshotResume?.liveState;
    if (!liveState) return;

    snapshotEvaluatedRef.current = true;
    const after = activeSnapshotResumeAfterSeq(liveState);
    if (after === null) return;

    // Active snapshots resume from the read-model projection cursor, not the
    // live head (`nextSeq - 1`): stream.delta rows above this cursor are in the
    // journal but not in the snapshot's blocks yet, so replaying from here
    // reconstructs the in-progress text without duplicating materialized rows.

    pendingResumeRef.current = true;
    startResume(after, liveState.runningTurnId ?? undefined);
  }, [
    actions,
    controller,
    continuityChecked,
    queryClient,
    continuity,
    projectId,
    restoreFailedSubmission,
    restoreLatestDraft,
    snapshotResume?.liveState,
    threadId,
  ]);
}
