/**
 * ChatView — the full conversation view for a thread (project chat and the
 * independent `/chat/:threadId` surface).
 *
 * Composition root for the chat feature: reads canonical turns directly from
 * ThreadStore, wires snapshot sync, handoff, announcements, and renders
 * `ChatSurface` + `TurnList` + `Composer`. Scroll/follow is owned by the
 * virtualized viewport inside `TurnList`, so there is no scroll-parent
 * plumbing here.
 *
 * Pending AI changes live in the composer-attached `DraftDock` (a single,
 * work-scoped strip that shares the composer's border box), never in the
 * transcript.
 *
 * Reads AI-draft review state from `DraftReviewProvider`; the dock and the
 * editor bar share one controller so preview selection cannot drift.
 */
import { t } from "@lingui/core/macro";
import type { Thread, ThreadLiveState, Turn, Work } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { resolveDocumentLink } from "@/client/api/document-links-api";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import {
  getChatSubmissionEpoch,
  recordChatSubmission,
  retireChatSubmission,
} from "@/client/chat-submissions";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useThreadAvailableSkills } from "@/client/query/useAvailableSkills";
import { announce, announceError, useThreadActions, useThreadStore } from "@/client/stores";
import {
  Composer,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
} from "@/components/app/composer";
import { documentLinkTarget, type LinkTarget } from "@/core/editor/links";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { displayThreadTitle } from "@/lib/thread-title";
import { TranscriptLinkNavigationContext } from "@/rich-content/TranscriptReference";
import { AgentOnlyComposerToolbar, ChatComposerToolbar } from "./ChatComposerToolbar";
import { ChatSurface } from "./ChatSurface";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { DraftDock, useDraftDock } from "./DraftDock";
import { canRestoreRejectedDraft, restoreRejectedDraft } from "./rejected-draft";
import { PendingInboxTray } from "./PendingInboxTray";
import { writerPendingInbox } from "./pending-inbox";
import { RunningSubagentsStrip } from "./RunningSubagentsStrip";
import { TurnList } from "./TurnList";
import { activeDescendants } from "./thread-activity";
import type { UserTurnRecovery } from "./UserTurn";
import {
  type FailedChatSubmission,
  forgetSubmissionTurnId,
  rememberSubmissionTurnId,
  submissionTurnId,
  useChatSubmissionRecovery,
} from "./useChatSubmissionRecovery";
import { useChatThreadSession } from "./useChatThreadSession";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";
import { usePendingInbox } from "./usePendingInbox";
import { useThreadActivity } from "./useThreadActivity";
import { useThreadDurableProjections } from "./useThreadDurableProjections";
import { useThreadHandoff } from "./useThreadHandoff";
import { useThreadNavigationAnnounce } from "./useThreadNavigationAnnounce";

const EMPTY_TURNS: Turn[] = [];

export type ChatViewProps = {
  threadId: string;
  projectId?: string | null;
  activeThread?: Thread | null;
  activeWork?: Work | null;
  snapshotLiveState?: ThreadLiveState | null;
  snapshotNextSeq?: string | null;
  /**
   * Whether the thread snapshot request has resolved. Feeds the transcript's
   * conversation-reveal ownership: only a settled history can say a named turn
   * is not in this conversation.
   */
  historySettled: boolean;
};

export function ChatView({
  threadId,
  projectId = null,
  activeThread = null,
  activeWork = null,
  snapshotLiveState = null,
  snapshotNextSeq = null,
  historySettled,
}: ChatViewProps) {
  const openReferenceDocument = useOpenProjectDocument(projectId ?? undefined);
  const actions = useThreadActions();
  const { changeTrails } = useThreadDurableProjections({ threadId, projectId });
  const queryClient = useQueryClient();
  const composerRef = useRef<ComposerHandle>(null);
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const [tailFollowRevision, requestTailFollow] = useReducer((value: number) => value + 1, 0);

  const controller = useMeridianAgent();
  const accountId = useAccountId();
  const turns = useThreadStore((state) => state.turnsByThread[threadId] ?? EMPTY_TURNS);
  const latestAssistantTurn =
    [...turns].reverse().find((turn) => turn.role === "assistant") ?? null;
  const isStreaming = latestAssistantTurn?.status === "streaming";
  const composerAgentName = activeThread?.agentName ?? "General";

  const pageTitle = activeThread?.title ? displayThreadTitle(activeThread.title) : t`New chat`;
  const referenceCatalog = useReferenceBrowserCatalog(
    projectId,
    activeWork?.id,
    t`Reference a file`,
  );
  const availableSkills = useThreadAvailableSkills(threadId);
  const activity = useThreadActivity({
    threadId,
    rootThreadId: activeThread?.rootThreadId ?? threadId,
    seed: snapshotLiveState,
  });
  const runningSubagents = activeDescendants(activity.activity);
  const pendingInbox = usePendingInbox({ threadId, seed: snapshotLiveState });

  useThreadNavigationAnnounce(threadId, pageTitle, composerRef);

  useChatThreadSession({
    threadId,
    projectId,
    controller,
    actions,
    isStreaming,
  });

  const submissionRecovery = useChatSubmissionRecovery(threadId, accountId, controller, actions);
  const failedSendRetry = useThreadHandoff(threadId, projectId, accountId, controller, actions, {
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
  });
  useLiveTurnAnnouncements(threadId, latestAssistantTurn, composerRef, chatSurfaceRef);

  const draftMode = activeWork?.aiWriteMode === "draft";
  // Generating signal: the current thread's latest assistant turn is streaming
  // AND the Work is in draft mode. That is the cleanest "this streaming turn is
  // producing draft edits" signal available client-side (per-turn draft lineage
  // is a later server phase); auto-apply streams never light the dock.
  const generating = isStreaming && draftMode;
  const dock = useDraftDock({ generating });

  async function handleSubmit(envelope: ComposerSubmitEnvelope) {
    const text = envelope.text;
    // Durable witness before display and dispatch: a displayed action survives
    // reload only if the intent was persisted first. If the journal refuses the
    // write, do not show a row or dispatch — keep the draft and report failure.
    const epoch = getChatSubmissionEpoch();
    const recorded = recordChatSubmission(accountId, {
      kind: "existing-thread",
      submissionId: envelope.submissionId,
      threadId,
      projectId: projectId ?? null,
      createdAt: new Date().toISOString(),
      text,
      blocks: [...envelope.blocks],
      references: [...envelope.references],
      activatedSkillSlugs: [...envelope.activatedSkillSlugs],
    });
    if (!recorded) {
      return {
        kind: "rejected" as const,
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    }
    requestTailFollow();
    const optimisticUserTurn = actions.appendUserTurn(threadId, text);
    // Register the live row before the POST awaits admission: a thread remount
    // while the server still holds the lease must reuse it, not append a second
    // pending copy. Cleared below on acknowledgement or proved rejection.
    rememberSubmissionTurnId(accountId, envelope.submissionId, optimisticUserTurn.id);
    try {
      const outcome = await controller.submit(threadId, envelope, {
        optimisticUserTurnId: optimisticUserTurn.id,
        keepOptimisticOnFailure: true,
      });
      if (outcome.kind === "accepted") {
        forgetSubmissionTurnId(accountId, envelope.submissionId);
        retireChatSubmission(accountId, envelope.submissionId, epoch);
      } else if (outcome.kind === "rejected") {
        // A proved rejection stays on the turn with edit/retry recovery; the
        // recovery owner retires the journal witness and retains the payload.
        submissionRecovery.markRejected(envelope.submissionId, optimisticUserTurn.id);
      }
      return outcome;
    } catch (error) {
      // An unexpected throw is ambiguous: keep the row and journal so a reload
      // can still reconcile or replay instead of losing the displayed send.
      announceError(error instanceof Error ? error.message : "Failed to submit message");
      return {
        kind: "ambiguous" as const,
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    } finally {
      // The PRIOR assistant turn may have errored and the projector clears it
      // off `status:error` when the next user turn arrives — a side-effect with
      // no journal/WS event. Refresh only after submit settles so this fetch
      // cannot race ahead of a persisted user turn. Ambiguous transport failures
      // retain the row until a later acknowledgement or reload can reconcile;
      // a proved rejection keeps the failed row for edit/retry recovery.
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
    }
  }

  const restoreRejectedMessage = useCallback((entry: FailedChatSubmission) => {
    const composer = composerRef.current;
    if (!composer) return;
    // A live send left the draft in the composer, so Edit focuses it. Only a
    // plain-text rejection with an empty composer can be restored faithfully;
    // a structured message has no blocks-to-composer inverse, and a live draft
    // is never replaced.
    restoreRejectedDraft(composer, entry.fingerprint);
  }, []);

  const settleQuarantined = useCallback(
    async (envelope: ComposerSubmitEnvelope, retire: boolean) => {
      const optimisticUserTurnId = submissionTurnId(accountId, envelope.submissionId);
      const epoch = getChatSubmissionEpoch();
      const outcome = await (retire
        ? controller.retire(threadId, envelope, { optimisticUserTurnId })
        : controller.lookup(threadId, envelope, {
            optimisticUserTurnId,
            keepOptimisticOnFailure: true,
          }));
      if (!retire && outcome.kind === "not-seen" && optimisticUserTurnId) {
        // The server never saw this submission. Replay the stored fingerprint
        // through the shared recovery path with the live optimistic row so the
        // displayed send is not lost; this surface owns no second re-issue.
        // The replay carries revision 0, so keep the envelope's revision.
        const replayOutcome = await submissionRecovery.replaySubmission(
          envelope.submissionId,
          optimisticUserTurnId,
        );
        if (replayOutcome.kind === "accepted") {
          forgetSubmissionTurnId(accountId, envelope.submissionId);
        }
        return { ...replayOutcome, acceptedRevision: envelope.acceptedRevision };
      }
      if (outcome.kind === "accepted" || (retire && outcome.kind === "rejected")) {
        // Acknowledgement, or writer-directed Start over: retire the witness.
        forgetSubmissionTurnId(accountId, envelope.submissionId);
        retireChatSubmission(accountId, envelope.submissionId, epoch);
      } else if (outcome.kind === "rejected" && optimisticUserTurnId) {
        // A definitive rejection keeps the failed row with edit/retry recovery.
        submissionRecovery.markRejected(envelope.submissionId, optimisticUserTurnId);
      }
      return outcome;
    },
    [accountId, controller, submissionRecovery, threadId],
  );

  function handleStop() {
    controller.cancel(threadId);
  }

  const handleRespondToInterrupt = useCallback(
    (request: InterruptRespondRequest) => controller.respondInterrupt(request),
    [controller],
  );

  const transcriptNavigation = useRef<AbortController | null>(null);
  useEffect(() => () => transcriptNavigation.current?.abort(), [projectId, activeWork?.id]);
  const followTranscriptLink = useCallback(
    async (target: LinkTarget) => {
      if (!projectId || target.kind === "relative") return;
      const request = documentLinkTarget(target, "");
      if (!request) return;
      transcriptNavigation.current?.abort();
      const attempt = new AbortController();
      transcriptNavigation.current = attempt;
      try {
        const result = await resolveDocumentLink(
          projectId,
          {
            workId: activeWork?.id,
            target: request,
          },
          { signal: attempt.signal },
        );
        if (attempt.signal.aborted) return;
        if (!result.document) {
          announce(t`No document with this name yet`);
          return;
        }
        await openReferenceDocument({
          documentId: result.document.documentId,
          disposition: "current",
        });
      } catch {
        if (!attempt.signal.aborted) announceError(t`That link could not be checked`);
      }
    },
    [projectId, activeWork?.id, openReferenceDocument],
  );

  const submissionRecoveryByTurnId = new Map<string, UserTurnRecovery>();
  for (const entry of submissionRecovery.recovered) {
    submissionRecoveryByTurnId.set(entry.optimisticTurnId, {
      kind: "ambiguous",
      onCheck: () => submissionRecovery.check(entry.submissionId),
      onRetire: () => submissionRecovery.retire(entry.submissionId),
    });
  }
  for (const entry of submissionRecovery.rejected) {
    const draftIsRecoverable = entry.draftRetained || canRestoreRejectedDraft(entry.fingerprint);
    submissionRecoveryByTurnId.set(entry.optimisticTurnId, {
      kind: "rejected",
      onRetry: () => {
        void submissionRecovery.retry(entry.optimisticTurnId);
      },
      // Edit focuses a live draft or restores a plain-text message. A structured
      // rejection whose draft is gone cannot be rebuilt, so only Retry remains.
      ...(draftIsRecoverable ? { onEdit: () => restoreRejectedMessage(entry) } : {}),
    });
  }

  return (
    <TranscriptLinkNavigationContext.Provider value={projectId ? followTranscriptLink : undefined}>
      <ChatSurface
        title={pageTitle}
        surfaceRef={chatSurfaceRef}
        header={
          runningSubagents.length > 0 ? (
            <RunningSubagentsStrip selfStatus={activity.status} descendants={runningSubagents} />
          ) : null
        }
        footer={
          <div data-debug-composer={threadId}>
            <PendingInboxTray pending={writerPendingInbox(pendingInbox)} />
            {/* The dock strip sits BEHIND (below) the composer — narrower via
              mx-2, top corners rounded, jade-tinted background. The composer
              always keeps its own border and overlaps the strip's edge. */}
            <DraftDock dock={dock} />
            <Composer
              onOpenReference={
                projectId
                  ? (reference) => {
                      void openReferenceDocument({
                        documentId: reference.documentId,
                        disposition: "current",
                      });
                    }
                  : undefined
              }
              ref={composerRef}
              variant="pinned"
              streaming={isStreaming}
              referenceCatalog={referenceCatalog}
              availableSkills={availableSkills.skills}
              uploadPort={uploadIntakePort}
              uploadScope={
                projectId && activeWork
                  ? { kind: "work", projectId, workId: activeWork.id }
                  : undefined
              }
              onSubmit={handleSubmit}
              onCheckSubmission={(envelope) => settleQuarantined(envelope, false)}
              onRetireSubmission={(envelope) => settleQuarantined(envelope, true)}
              onStop={handleStop}
              toolbarLeft={
                !projectId ? (
                  <AgentOnlyComposerToolbar
                    control={{ mode: "readonly", name: composerAgentName }}
                  />
                ) : activeWork ? (
                  <ChatComposerToolbar
                    projectId={projectId}
                    threadId={threadId}
                    work={activeWork}
                    agentName={composerAgentName}
                  />
                ) : undefined
              }
            />
          </div>
        }
      >
        <TurnList
          threadId={threadId}
          turns={turns}
          historySettled={historySettled}
          tailFollowRevision={tailFollowRevision}
          ariaLabel={t`Chat`}
          onRespondToInterrupt={handleRespondToInterrupt}
          failedSendRetry={failedSendRetry}
          changeTrails={changeTrails.byId}
          submissionRecoveryByTurnId={submissionRecoveryByTurnId}
        />
      </ChatSurface>
    </TranscriptLinkNavigationContext.Provider>
  );
}
