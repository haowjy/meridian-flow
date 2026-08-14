/**
 * useThreadHandoff — starts the chat stream that belongs to this thread mount.
 *
 * The hook owns both optimistic Home→Project handoff resume and snapshot-based
 * reload resume. Keeping them in one place prevents two controller runs from
 * subscribing to the same active thread during mount.
 */

import type { ThreadLiveState } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { createProject } from "@/client/api/projects-api";
import { createThread } from "@/client/api/threads-api";
import {
  isThreadAdmissionError,
  type ThreadRunController,
} from "@/client/copilot/ThreadRunController";
import { invalidateProjectThreadData } from "@/client/query/project-invalidation";
import type { ThreadStoreActions } from "@/client/stores";
import { announceError, useThreadStore } from "@/client/stores";
import type { ComposerDraftRestoration } from "@/components/app/composer";
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
 * an in-flight run or performs the deferred Home/Draft first-message handoff.
 */
export function useThreadHandoff(
  threadId: string,
  controller: Controller,
  actions: ThreadStoreActions,
  snapshotResume?: SnapshotResumeState,
  restoreFirstSendDraft?: (restoration: ComposerDraftRestoration) => boolean,
): void {
  const pendingResumeRef = useRef(false);
  const handoffStartedRef = useRef(false);
  const snapshotEvaluatedRef = useRef(false);
  const restoredFirstSendIdsRef = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const firstSend = useThreadStore((state) => state.firstSendByThreadId[threadId] ?? null);

  useEffect(() => {
    if (firstSend?.draftAfterRoute === undefined || firstSend.draftAfterRouteRestored) return;
    if (firstSend.status !== "armed" && firstSend.status !== "claimed") return;
    const restored = restoreFirstSendDraft?.({
      id: `${threadId}:route-draft`,
      text: firstSend.draftAfterRoute,
    });
    if (restored) actions.ackFirstSendRouteDraftRestored(threadId);
  }, [actions, firstSend, restoreFirstSendDraft, threadId]);

  useEffect(() => {
    pendingResumeRef.current = false;
    handoffStartedRef.current = false;
    snapshotEvaluatedRef.current = false;
  }, [threadId]);

  useEffect(() => {
    if (firstSend?.status !== "failed" || firstSend.claimId === undefined) return;
    const restorationId = `${threadId}:${firstSend.claimId}`;
    if (restoredFirstSendIdsRef.current.has(restorationId)) return;
    const restored = restoreFirstSendDraft?.({
      id: restorationId,
      text: firstSend.text,
    });
    if (restored) {
      restoredFirstSendIdsRef.current.add(restorationId);
      actions.ackFirstSendDraftRestored(threadId, firstSend.claimId);
    }
  }, [actions, firstSend, restoreFirstSendDraft, threadId]);

  useEffect(() => {
    if (firstSend) {
      const claim = actions.claimFirstSend(threadId);
      if (!claim) return;
      handoffStartedRef.current = true;
      void controller
        .submit(threadId, claim.text, {
          optimisticUserTurnId: claim.optimisticUserTurnId,
        })
        .then(() => {
          actions.ackFirstSend(threadId, claim.claimId);
        })
        .catch((error) => {
          const rejection = isThreadAdmissionError(error) ? error.kind : "ambiguous";
          actions.rejectFirstSend(threadId, claim.claimId, rejection);
          const message = error instanceof Error ? error.message : "Failed to start stream";
          announceError(message);
        });
      return;
    }

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
      void controller
        .submit(threadId, text, { optimisticUserTurnId })
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

      if (pendingStream.deferredSend) {
        const { projectId, title, text, optimisticUserTurnId, currentAgent } =
          pendingStream.deferredSend;
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
            await invalidateProjectThreadData(queryClient, projectId);
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
    queryClient,
    restoreFirstSendDraft,
    firstSend,
    snapshotResume?.liveState,
    threadId,
  ]);
}
