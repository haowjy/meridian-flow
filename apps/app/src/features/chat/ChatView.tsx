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
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError, useThreadActions, useThreadStore } from "@/client/stores";
import {
  Composer,
  type ComposerDraftSnapshot,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
} from "@/components/app/composer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { documentLinkTarget, type LinkTarget } from "@/core/editor/links";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { displayThreadTitle } from "@/lib/thread-title";
import { TranscriptLinkNavigationContext } from "@/rich-content/TranscriptReference";
import { AgentOnlyComposerToolbar, ChatComposerToolbar } from "./ChatComposerToolbar";
import { ChatSurface } from "./ChatSurface";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { DraftDock, useDraftDock } from "./DraftDock";
import { TurnList } from "./TurnList";
import { useChatThreadSession } from "./useChatThreadSession";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";
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
  const optimisticBySubmission = useRef(new Map<string, string>());
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const [tailFollowRevision, requestTailFollow] = useReducer((value: number) => value + 1, 0);

  const controller = useMeridianAgent();
  const turns = useThreadStore((state) => state.turnsByThread[threadId] ?? EMPTY_TURNS);
  const latestAssistantTurn =
    [...turns].reverse().find((turn) => turn.role === "assistant") ?? null;
  const isStreaming = latestAssistantTurn?.status === "streaming";
  const composerAgentName = activeThread?.agentName ?? activeThread?.currentAgent ?? "General";

  const pageTitle = activeThread?.title ? displayThreadTitle(activeThread.title) : t`New chat`;
  const referenceCatalog = useReferenceBrowserCatalog(
    projectId,
    activeWork?.id,
    t`Reference a file`,
  );

  useThreadNavigationAnnounce(threadId, pageTitle, composerRef);

  useChatThreadSession({
    threadId,
    projectId,
    controller,
    actions,
    isStreaming,
  });

  const restoreFirstSendDraft = useCallback(
    (snapshot: ComposerDraftSnapshot, expectedRevision: number) => {
      const composer = composerRef.current;
      return composer?.restoreSnapshot(snapshot, expectedRevision)
        ? composer.snapshot().revision
        : null;
    },
    [],
  );
  const restoreFailedFirstSend = useCallback(
    (
      id: string,
      submitted: ComposerDraftSnapshot,
      later: ComposerDraftSnapshot | null | undefined,
      expectedRevision: number,
    ) => {
      const composer = composerRef.current;
      return composer?.restoreFailedSubmission(id, submitted, later, expectedRevision)
        ? composer.snapshot().revision
        : null;
    },
    [],
  );
  const restoreRecovery = useCallback<ComposerHandle["restoreFirstSendRecovery"]>(
    (input) => composerRef.current?.restoreFirstSendRecovery(input) ?? null,
    [],
  );
  const handoff = useThreadHandoff(
    threadId,
    projectId,
    controller,
    actions,
    {
      liveState: snapshotLiveState,
      nextSeq: snapshotNextSeq,
    },
    restoreFirstSendDraft,
    restoreFailedFirstSend,
    restoreRecovery,
  );
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
    requestTailFollow();
    const optimisticUserTurn = actions.appendUserTurn(threadId, text);
    optimisticBySubmission.current.set(envelope.submissionId, optimisticUserTurn.id);
    try {
      const outcome = await controller.submit(threadId, envelope, {
        optimisticUserTurnId: optimisticUserTurn.id,
      });
      if (outcome.kind !== "ambiguous")
        optimisticBySubmission.current.delete(envelope.submissionId);
      return outcome;
    } catch (error) {
      actions.removeOptimisticUserTurn(threadId, optimisticUserTurn.id);
      announceError(error instanceof Error ? error.message : "Failed to submit message");
      return {
        kind: "rejected" as const,
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    } finally {
      // The PRIOR assistant turn may have errored and the projector clears it
      // off `status:error` when the next user turn arrives — a side-effect with
      // no journal/WS event. Refresh only after submit settles so this fetch
      // cannot race ahead of a persisted user turn. Definitive API rejections
      // roll back the optimistic row; ambiguous transport failures retain it
      // until a later acknowledgement or reload can reconcile the write.
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
    }
  }

  const settleQuarantined = useCallback(
    async (envelope: ComposerSubmitEnvelope, retire: boolean) => {
      const optimisticUserTurnId = optimisticBySubmission.current.get(envelope.submissionId);
      const outcome = await (retire
        ? controller.retire(threadId, envelope, { optimisticUserTurnId })
        : controller.lookup(threadId, envelope, { optimisticUserTurnId }));
      if (outcome.kind !== "ambiguous")
        optimisticBySubmission.current.delete(envelope.submissionId);
      return outcome;
    },
    [controller, threadId],
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

  return (
    <TranscriptLinkNavigationContext.Provider value={projectId ? followTranscriptLink : undefined}>
      <ChatSurface
        title={pageTitle}
        surfaceRef={chatSurfaceRef}
        footer={
          <div data-debug-composer={threadId}>
            {/* The dock strip sits BEHIND (below) the composer — narrower via
              mx-2, top corners rounded, jade-tinted background. The composer
              always keeps its own border and overlaps the strip's edge. */}
            <DraftDock dock={dock} />
            {handoff.recovery ? (
              <Alert role="status">
                <AlertTitle>{t`Saved first message`}</AlertTitle>
                <AlertDescription>
                  <p>{t`Check this message before sending another. You can keep drafting below.`}</p>
                  <details>
                    <summary>{t`View saved message`}</summary>
                    <p className="whitespace-pre-wrap break-words">{handoff.recovery.text}</p>
                  </details>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={handoff.recovery.busy}
                      onClick={() => void handoff.recovery?.checkStatus()}
                    >{t`Check status`}</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={handoff.recovery.busy}
                      onClick={() => void handoff.recovery?.startOver()}
                    >{t`Start over`}</Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            <Composer
              submitDisabled={handoff.blocksSubmission}
              submitDisabledReason={
                handoff.blocksSubmission
                  ? t`Check the saved first message before sending another.`
                  : undefined
              }
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
              uploadPort={uploadIntakePort}
              uploadScope={
                projectId
                  ? activeWork
                    ? { kind: "work", projectId, workId: activeWork.id, workSlug: activeWork.slug }
                    : { kind: "none", projectId }
                  : undefined
              }
              onSubmit={handleSubmit}
              onCheckSubmission={(envelope) => settleQuarantined(envelope, false)}
              onRetireSubmission={(envelope) => settleQuarantined(envelope, true)}
              onStop={handleStop}
              toolbarLeft={
                projectId && activeWork ? (
                  <ChatComposerToolbar
                    projectId={projectId}
                    threadId={threadId}
                    work={activeWork}
                    agentName={composerAgentName}
                  />
                ) : (
                  <AgentOnlyComposerToolbar
                    control={{ mode: "readonly", name: composerAgentName }}
                  />
                )
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
          changeTrails={changeTrails.byId}
        />
      </ChatSurface>
    </TranscriptLinkNavigationContext.Provider>
  );
}
