/**
 * useThreadHandoff — starts the chat stream that belongs to this thread mount.
 *
 * Owns navigate-first persist (create/admit/run), snapshot-based reload resume,
 * and Retry of a failed first send with the same thread and message ids.
 */

import type { Thread, ThreadLiveState } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createProject, createProjectThread, getProject } from "@/client/api/projects-api";
import { createThread } from "@/client/api/threads-api";
import { getChatSubmissionEpoch, readFirstSendSubmission } from "@/client/chat-submissions";
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
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import {
  rehydrateFirstSendSubmission,
  retireFirstSendSubmission,
  runExclusiveThreadCreation,
} from "@/lib/send-project-chat";
import { shouldRetireSubmission } from "./chat-submission-retirement";

type Controller = ThreadRunController;
type Creation = NonNullable<PendingStreamStart["creation"]>;

export type FailedSendRetry = {
  turnId: string;
  retry: () => void;
};

type SnapshotResumeState = {
  liveState: ThreadLiveState | null;
  nextSeq: string | null;
  activateProjection: (after?: string) => boolean;
};

function isActiveSnapshot(liveState: ThreadLiveState): boolean {
  return liveState.runningTurnId !== null || liveState.status.kind === "awake";
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
  accountId: string,
  controller: Controller,
  actions: ThreadStoreActions,
  snapshotResume: SnapshotResumeState,
): FailedSendRetry | null {
  const pendingResumeRef = useRef(false);
  const handoffStartedRef = useRef(false);
  const resumedRunRef = useRef<string | null>(null);
  const creationRef = useRef<Creation | undefined>(undefined);
  const persistRef = useRef<(creation: Creation) => void>(() => undefined);
  const sendSucceededRef = useRef(false);
  const [failedTurnId, setFailedTurnId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const providedEpoch = useOptionalAccountEpochSignal();
  const fallbackEpoch = useRef<AbortController | null>(null);
  fallbackEpoch.current ??= new AbortController();
  const accountEpoch = providedEpoch ?? fallbackEpoch.current.signal;
  const lifetimeRef = useRef<object | null>(null);
  useEffect(() => {
    const lifetime = {};
    lifetimeRef.current = lifetime;
    return () => {
      if (lifetimeRef.current === lifetime) lifetimeRef.current = null;
    };
  }, [accountEpoch, projectId, threadId]);
  const isCurrent = (lifetime: object) => lifetimeRef.current === lifetime && !accountEpoch.aborted;

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
        if (!snapshotResume.activateProjection()) return;
        controller.resume(threadId, { after, expectedTurnId });
      } catch (error) {
        announceError(error instanceof Error ? error.message : "Failed to resume stream");
      } finally {
        pendingResumeRef.current = false;
      }
    };

    const finishFirstSend = (creation: Creation, epoch: number) => {
      if (creation.submissionId) {
        retireFirstSendSubmission(accountId, creation.submissionId, threadId, actions, epoch);
        return;
      }
      actions.clearPendingCreation({ threadId });
    };

    const startSubmit = (creation: Creation, lifetime: object) => {
      if (!isCurrent(lifetime)) return;
      if (!creation.text) {
        if (!snapshotResume.activateProjection()) return;
        pendingResumeRef.current = false;
        finishFirstSend(creation, getChatSubmissionEpoch());
        return;
      }
      const envelope = {
        ...serializeComposerDraft(plainComposerDoc(creation.text)),
        activatedSkillSlugs: creation.activatedSkillSlugs ?? [],
      };
      // Capture the account bind before dispatch: an A→B→A return while the
      // POST is in flight must not delete the entry the new session needs.
      const epoch = getChatSubmissionEpoch();
      void controller
        .submit(
          threadId,
          creation.submissionId ? { ...envelope, submissionId: creation.submissionId } : envelope,
          {
            optimisticUserTurnId: creation.optimisticUserTurnId,
            keepOptimisticOnFailure: true,
            activateProjection: (after) =>
              isCurrent(lifetime) && snapshotResume.activateProjection(after),
          },
        )
        .then((outcome) => {
          if (!isCurrent(lifetime)) return;
          if (outcome.kind === "accepted") {
            clearFailedSend();
            finishFirstSend(creation, epoch);
            return;
          }
          // A definitive rejection is a resolved outcome: retire the durable
          // intent. Ambiguous and not-seen outcomes keep it for reload replay.
          if (shouldRetireSubmission(outcome) && creation.submissionId) {
            retireFirstSendSubmission(accountId, creation.submissionId, threadId, actions, epoch);
          }
          failSend(creation);
        })
        .catch(() => {
          if (!isCurrent(lifetime)) return;
          failSend(creation);
        })
        .finally(() => {
          if (isCurrent(lifetime)) pendingResumeRef.current = false;
        });
    };

    const persistCreation = (creation: Creation) => {
      const lifetime = lifetimeRef.current;
      if (!lifetime || !isCurrent(lifetime)) return;
      creationRef.current = creation;
      handoffStartedRef.current = true;
      pendingResumeRef.current = true;
      sendSucceededRef.current = false;
      setFailedTurnId(null);
      if (creation.workingTurnId) {
        actions.patchTurnStatus(threadId, creation.workingTurnId, "streaming");
      }
      void runExclusiveThreadCreation(accountEpoch, threadId, async (): Promise<Thread> => {
        if (accountEpoch.aborted) throw accountEpoch.reason;
        if (creation.createProject) {
          try {
            await createProject({ id: creation.projectId, title: creation.title });
          } catch (error) {
            if (accountEpoch.aborted) throw accountEpoch.reason;
            const existing = await getProject(creation.projectId).catch(() => {
              throw error;
            });
            if (existing.id !== creation.projectId || existing.userId !== accountId) throw error;
          }
          if (accountEpoch.aborted) throw accountEpoch.reason;
          return createThread({
            data: {
              id: threadId,
              projectId: creation.projectId,
              title: creation.title,
              agentSelection: creation.agentSelection,
            },
          });
        }
        return createProjectThread(creation.projectId, {
          id: threadId,
          title: creation.title,
          workId: creation.workId ?? null,
          agentSelection: creation.agentSelection,
        });
      })
        .then(async (thread) => {
          if (!isCurrent(lifetime)) return;
          actions.ensureThread(thread);
          if (creation.createProject) {
            actions.clearPendingCreation({ projectId: creation.projectId });
          }
          await Promise.all([
            invalidateProjectThreadData(queryClient, creation.projectId),
            ...(thread.workId
              ? [invalidateWorkThreads(queryClient, creation.projectId, thread.workId)]
              : []),
          ]);
          if (!isCurrent(lifetime)) return;
          startSubmit(creation, lifetime);
        })
        .catch(() => {
          if (isCurrent(lifetime)) failSend(creation);
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

    // Durable reload path: the in-memory pending stream and the same-tab
    // sessionStorage handoff are gone, but the account-stamped journal entry
    // still names the thread, message, and submission identity to replay.
    const submission = readFirstSendSubmission(accountId, threadId);
    if (submission && submission.projectId === projectId) {
      if (pendingResumeRef.current || handoffStartedRef.current) return;
      persistCreation(rehydrateFirstSendSubmission(submission, actions, accountId));
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
  }, [
    accountEpoch,
    accountId,
    actions,
    controller,
    projectId,
    queryClient,
    snapshotResume.activateProjection,
    snapshotResume.liveState,
    threadId,
  ]);

  const retry = useCallback(() => {
    const creation = creationRef.current;
    if (!creation) return;
    persistRef.current(creation);
  }, []);

  if (!failedTurnId) return null;
  return { turnId: failedTurnId, retry };
}
