/**
 * useThreadHandoff — starts the chat stream that belongs to this thread mount.
 *
 * Owns navigate-first persist (create/admit/run) and snapshot-based reload resume.
 */

import type { ThreadLiveState } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
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
): void {
  const pendingResumeRef = useRef(false);
  const handoffStartedRef = useRef(false);
  const snapshotEvaluatedRef = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    pendingResumeRef.current = false;
    handoffStartedRef.current = false;
    snapshotEvaluatedRef.current = false;
  }, [projectId, threadId]);

  useEffect(() => {
    const startResume = (after?: string, expectedTurnId?: string) => {
      try {
        controller.resume(threadId, { after, expectedTurnId });
      } catch (error) {
        announceError(error instanceof Error ? error.message : "Failed to resume stream");
      } finally {
        pendingResumeRef.current = false;
      }
    };

    const startSubmit = (text: string, optimisticUserTurnId?: string, submissionId?: string) => {
      const envelope = serializeComposerDraft(plainComposerDoc(text));
      void controller
        .submit(threadId, submissionId ? { ...envelope, submissionId } : envelope, {
          optimisticUserTurnId,
        })
        .catch((error) => {
          announceError(error instanceof Error ? error.message : "Failed to start stream");
        })
        .finally(() => {
          pendingResumeRef.current = false;
        });
    };

    const persistCreation = (creation: PendingStreamStart["creation"]) => {
      if (!creation) return;
      handoffStartedRef.current = true;
      pendingResumeRef.current = true;
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
            finishInflightChat(threadId, actions);
            await Promise.all([
              invalidateProjectThreadData(queryClient, creation.projectId),
              ...(thread.workId
                ? [invalidateWorkThreads(queryClient, creation.projectId, thread.workId)]
                : []),
            ]);
          }
          if (creation.text)
            startSubmit(creation.text, creation.optimisticUserTurnId, creation.submissionId);
          else pendingResumeRef.current = false;
        } catch (error) {
          if (creation.workingTurnId)
            actions.patchTurnStatus(threadId, creation.workingTurnId, "error");
          announceError(error instanceof Error ? error.message : "Couldn't send");
          pendingResumeRef.current = false;
        }
      });
    };

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
      if (pendingResumeRef.current) return;
      persistCreation({
        projectId: inflight.projectId,
        title: inflight.title,
        text: inflight.text,
        agentSelection: inflight.agentSelection,
        workId: inflight.workId,
        optimisticUserTurnId: inflight.optimisticUserTurnId,
        workingTurnId: inflight.workingTurnId,
        submissionId: inflight.submissionId,
        createProject: false,
      });
      return;
    }

    if (snapshotEvaluatedRef.current || handoffStartedRef.current) return;
    const liveState = snapshotResume?.liveState;
    if (!liveState) return;

    snapshotEvaluatedRef.current = true;
    const after = activeSnapshotResumeAfterSeq(liveState);
    if (after === null) return;

    pendingResumeRef.current = true;
    startResume(after, liveState.runningTurnId ?? undefined);
  }, [actions, controller, projectId, queryClient, snapshotResume?.liveState, threadId]);
}
