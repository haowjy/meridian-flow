/**
 * useThreadHandoff — starts the chat stream that belongs to this thread mount.
 *
 * Owns navigate-first persist (create/admit/run), snapshot-based reload resume,
 * and Retry of a failed first send with the same thread and message ids.
 */

import type { ThreadLiveState } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createProject, createProjectThread } from "@/client/api/projects-api";
import { createThread } from "@/client/api/threads-api";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import {
  invalidateProjectThreadData,
  invalidateWorkThreads,
} from "@/client/query/project-invalidation";
import type { PendingStreamStart, ThreadStoreActions } from "@/client/stores";
import { announceError } from "@/client/stores";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { runExclusivePersist } from "@/lib/inflight-chat";
import { finishInflightChat, rehydrateInflightChat } from "@/lib/send-project-chat";

type Controller = ThreadRunController;
type Creation = NonNullable<PendingStreamStart["creation"]>;

export type FailedSendRetry = {
  turnId: string;
  retry: () => void;
};

type SnapshotResumeState = {
  liveState: ThreadLiveState | null;
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

export function useThreadHandoff(
  threadId: string,
  projectId: string | null,
  controller: Controller,
  actions: ThreadStoreActions,
  snapshotResume?: SnapshotResumeState,
): FailedSendRetry | null {
  const pendingResumeRef = useRef(false);
  const handoffStartedRef = useRef(false);
  const resumedRunRef = useRef<string | null>(null);
  const creationRef = useRef<Creation | undefined>(undefined);
  const persistRef = useRef<(creation: Creation) => void>(() => undefined);
  const sendSucceededRef = useRef(false);
  const [failedTurnId, setFailedTurnId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    pendingResumeRef.current = false;
    handoffStartedRef.current = false;
    resumedRunRef.current = null;
    creationRef.current = undefined;
    sendSucceededRef.current = false;
    setFailedTurnId(null);
  }, [projectId, threadId]);

  useEffect(() => {
    const clearFailedSend = () => {
      sendSucceededRef.current = true;
      setFailedTurnId(null);
    };

    const failSend = (creation: Creation) => {
      if (sendSucceededRef.current) return;
      if (creation.workingTurnId)
        actions.patchTurnStatus(threadId, creation.workingTurnId, "error");
      setFailedTurnId(creation.workingTurnId ?? null);
      announceError("Couldn't send");
      pendingResumeRef.current = false;
    };

    const startResume = (after?: string, expectedTurnId?: string) => {
      try {
        controller.resume(threadId, { after, expectedTurnId });
      } catch (error) {
        announceError(error instanceof Error ? error.message : "Failed to resume stream");
      } finally {
        pendingResumeRef.current = false;
      }
    };

    const startSubmit = (creation: Creation) => {
      if (!creation.text) {
        pendingResumeRef.current = false;
        finishInflightChat(threadId, actions);
        return;
      }
      const envelope = {
        ...serializeComposerDraft(plainComposerDoc(creation.text)),
        activatedSkillSlugs: creation.activatedSkillSlugs ?? [],
      };
      void controller
        .submit(
          threadId,
          creation.submissionId ? { ...envelope, submissionId: creation.submissionId } : envelope,
          {
            optimisticUserTurnId: creation.optimisticUserTurnId,
            keepOptimisticOnFailure: true,
          },
        )
        .then((outcome) => {
          if (outcome.kind === "accepted") {
            clearFailedSend();
            finishInflightChat(threadId, actions);
            return;
          }
          failSend(creation);
        })
        .catch(() => {
          failSend(creation);
        })
        .finally(() => {
          pendingResumeRef.current = false;
        });
    };

    const persistCreation = (creation: Creation) => {
      creationRef.current = creation;
      handoffStartedRef.current = true;
      pendingResumeRef.current = true;
      sendSucceededRef.current = false;
      setFailedTurnId(null);
      if (creation.workingTurnId) {
        actions.patchTurnStatus(threadId, creation.workingTurnId, "streaming");
      }
      void runExclusivePersist(threadId, async () => {
        try {
          if (creation.createProject) {
            await createProject({ id: creation.projectId, title: creation.title });
            const thread = await createThread({
              data: {
                id: threadId,
                projectId: creation.projectId,
                title: creation.title,
                agentSelection: creation.agentSelection,
              },
            });
            actions.ensureThread(thread);
            actions.clearPendingCreation({ projectId: creation.projectId, threadId });
            await Promise.all([
              invalidateProjectThreadData(queryClient, creation.projectId),
              ...(thread.workId
                ? [invalidateWorkThreads(queryClient, creation.projectId, thread.workId)]
                : []),
            ]);
          } else {
            const thread = await createProjectThread(creation.projectId, {
              id: threadId,
              title: creation.title,
              workId: creation.workId ?? null,
              agentSelection: creation.agentSelection,
            });
            actions.ensureThread(thread);
            actions.clearPendingCreation({ threadId });
            await Promise.all([
              invalidateProjectThreadData(queryClient, creation.projectId),
              ...(thread.workId
                ? [invalidateWorkThreads(queryClient, creation.projectId, thread.workId)]
                : []),
            ]);
          }
          startSubmit(creation);
        } catch {
          failSend(creation);
        }
      });
    };
    persistRef.current = persistCreation;

    const pendingStream = actions.consumePendingStream(threadId);
    if (pendingStream) {
      if (pendingResumeRef.current) return;
      if (pendingStream.creation) {
        persistCreation(pendingStream.creation);
        return;
      }
      pendingResumeRef.current = true;
      handoffStartedRef.current = true;
      startResume(pendingStream.after, pendingStream.expectedTurnId);
      return;
    }

    const inflight = rehydrateInflightChat(threadId, actions);
    if (inflight && inflight.projectId === projectId) {
      if (pendingResumeRef.current || handoffStartedRef.current) return;
      persistCreation({
        projectId: inflight.projectId,
        title: inflight.title,
        text: inflight.text,
        agentSelection: inflight.agentSelection,
        workId: inflight.workId,
        optimisticUserTurnId: inflight.optimisticUserTurnId,
        workingTurnId: inflight.workingTurnId,
        submissionId: inflight.submissionId,
        activatedSkillSlugs: inflight.activatedSkillSlugs,
        createProject: false,
      });
      return;
    }

    const liveState = snapshotResume?.liveState;
    if (!liveState) return;

    const after = activeSnapshotResumeAfterSeq(liveState);
    if (after === null) return;

    // Attach a controller per distinct active run. Do not latch while idle, or a
    // later server-initiated run — a background child's report waking the parent
    // — would never get a subscriber to apply its deltas.
    const runKey = liveState.runningTurnId ?? after;
    if (resumedRunRef.current === runKey) return;

    if (handoffStartedRef.current && resumedRunRef.current === null) {
      // The send this mount started already owns this run's stream (submit
      // attached a controller). Record it so we do not attach a second one,
      // while still allowing a later run to resume.
      resumedRunRef.current = runKey;
      return;
    }

    resumedRunRef.current = runKey;
    pendingResumeRef.current = true;
    startResume(after, liveState.runningTurnId ?? undefined);
  }, [actions, controller, projectId, queryClient, snapshotResume?.liveState, threadId]);

  const retry = useCallback(() => {
    const creation = creationRef.current;
    if (!creation) return;
    persistRef.current(creation);
  }, []);

  if (!failedTurnId) return null;
  return { turnId: failedTurnId, retry };
}
