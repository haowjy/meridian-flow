/**
 * ChatView — the full conversation view for a project-owned thread.
 *
 * Composition root for the chat feature: reads canonical turns directly from
 * ThreadStore, wires snapshot sync, handoff, announcements, and renders
 * `ChatSurface` + `TurnList` + `Composer`. Scroll/follow is owned by the
 * virtualized viewport inside `TurnList`, so there is no scroll-parent
 * plumbing here.
 *
 * Pending AI changes live in the composer-attached `DraftDock` (a single,
 * work-scoped strip that shares the composer's border box), never in the
 * transcript. A host's `composerStrip` (the archived-Work notice) sits on the
 * composer's top edge above it; the composer itself always stays live.
 *
 * Reads AI-draft review state from `DraftReviewProvider`; the dock and the
 * editor bar share one controller so preview selection cannot drift.
 */
import { t } from "@lingui/core/macro";
import type { Thread, ThreadLiveState, Turn, Work } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback, useMemo, useReducer, useRef } from "react";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import {
  getChatSubmissionEpoch,
  recordChatSubmission,
  retireChatSubmission,
  settleChatSubmission,
} from "@/client/chat-submissions";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { useThreadAvailableSkills } from "@/client/query/useAvailableSkills";
import {
  announceError,
  useIsThreadPendingCreation,
  useThreadActions,
  useThreadStore,
} from "@/client/stores";
import {
  Composer,
  type ComposerChatCommand,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
} from "@/components/app/composer";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { LinkFollowDialog } from "@/features/links";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import { displayThreadTitle } from "@/lib/thread-title";
import { TranscriptLinkNavigationContext } from "@/rich-content/TranscriptReference";
import { ChatComposerToolbar } from "./ChatComposerToolbar";
import { ChatSurface } from "./ChatSurface";
import { useOpenChatThread } from "./ChatThreadNavigation";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { chatLineageId } from "./chat-scratch-owner";
import { answeredControlIds } from "./compaction/compaction-model";
import { useControlTurnAnnouncements } from "./compaction/useControlTurnAnnouncements";
import { useThreadControls } from "./compaction/useThreadControls";
import { composerRun } from "./composer-run";
import { DraftDock, useDraftDock } from "./DraftDock";
import {
  canDeriveFrom,
  type TurnDerivation,
  TurnDerivationProvider,
} from "./derivation/DeriveTurnActions";
import {
  type DerivationDeps,
  startDerivation,
  useDerivationStatus,
  whenDerived,
} from "./derivation/derive-conversation";
import { isHandoffSeed, optimisticHandoffSeed } from "./derivation/handoff-seed";
import { optimisticForkPrefix, useInheritedView } from "./derivation/inherited-view";
import { useHandoffBrief } from "./derivation/useHandoffBrief";
import { queuedWriterTurnIds as selectQueuedWriterTurnIds } from "./pending-inbox";
import { RunningSubagentsStrip } from "./RunningSubagentsStrip";
import { ReferenceAvailabilityContext } from "./reference-availability";
import { placeStandIns } from "./retry-stand-ins";
import { SubagentActivityProvider } from "./subagent/ActivityContext";
import { SubagentDisclosureProvider } from "./subagent/DisclosureStore";
import { TurnList } from "./TurnList";
import { activeChildren } from "./thread-activity";
import type { UserTurnRecovery } from "./UserTurn";
import { useChatLinkFollowing } from "./useChatLinkFollowing";
import {
  forgetSubmissionTurnId,
  rememberSubmissionTurnId,
  submissionTurnId,
  useChatSubmissionRecovery,
} from "./useChatSubmissionRecovery";
import { useChatThreadSession } from "./useChatThreadSession";
import { useComposerSessionDraft } from "./useComposerSessionDraft";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";
import { usePendingInbox } from "./usePendingInbox";
import { useReplyRetry } from "./useReplyRetry";
import { useThreadActivity } from "./useThreadActivity";
import { useThreadDurableProjections } from "./useThreadDurableProjections";
import { useThreadHandoff } from "./useThreadHandoff";
import { useThreadNavigationAnnounce } from "./useThreadNavigationAnnounce";

const EMPTY_TURNS: Turn[] = [];

export type ChatViewProps = {
  threadId: string;
  projectId: string;
  activeThread?: Thread | null;
  activeWork?: Work | null;
  snapshotLiveState?: ThreadLiveState | null;
  snapshotNextSeq?: string | null;
  snapshotThreadUsage?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheReportedInputTokens: number;
    cacheReportedCalls: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheResets: number;
  } | null;
  /**
   * Whether the thread snapshot request has resolved. Feeds the transcript's
   * conversation-reveal ownership: only a settled history can say a named turn
   * is not in this conversation.
   */
  historySettled: boolean;
  activateProjection: (after?: string) => boolean;
  /** A notice framed onto the composer's top edge; the composer stays usable under it. */
  composerStrip?: ReactNode;
  /** False while the chat is mounted but hidden (collapsed dock, Settings). */
  active?: boolean;
};

export function ChatView({
  threadId,
  projectId,
  activeThread = null,
  activeWork = null,
  snapshotLiveState = null,
  snapshotNextSeq = null,
  snapshotThreadUsage = null,
  historySettled,
  activateProjection,
  composerStrip,
  active = true,
}: ChatViewProps) {
  const openReferenceDocument = useOpenChatDocument(projectId);
  const actions = useThreadActions();
  const { changeTrails } = useThreadDurableProjections({ threadId, projectId });
  const composerRef = useRef<ComposerHandle>(null);
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const [tailFollowRevision, requestTailFollow] = useReducer((value: number) => value + 1, 0);

  const controller = useMeridianAgent();
  const accountId = useAccountId();
  const draft = useComposerSessionDraft(accountId, { kind: "chat", id: threadId });
  const accountSignal = useAccountEpochSignal();
  const openThread = useOpenChatThread();
  const pendingCreation = useIsThreadPendingCreation(threadId);
  const derivation = useDerivationStatus(threadId);
  const inherited = useInheritedView(activeThread, derivation?.inherited ?? null);
  const storedTurns = useThreadStore((state) => state.turnsByThread[threadId] ?? EMPTY_TURNS);
  const brief = useHandoffBrief({ threadId, storedTurns });
  const replyRetry = useReplyRetry({ threadId, storedTurns });
  // A handoff's brief is on its way the moment the writer lands; until the
  // server's seed arrives the card stands in for it (it has nothing to stop
  // yet). A Retry's new card, or a failed reply's new reply, stands after the
  // turn it followed until the server has it.
  const intent = derivation?.intent;
  const { localSeeds } = brief;
  const { standIns: replyStandIns } = replyRetry;
  const turns = useMemo(() => {
    const opening =
      intent?.kind === "handoff" &&
      derivation?.state !== "failed" &&
      !storedTurns.some(isHandoffSeed)
        ? [
            optimisticHandoffSeed({
              threadId,
              sourceThreadId: intent.sourceThreadId,
              sourceTitle: intent.sourceTitle,
              cutoffTurnId: intent.originTurnId,
              createdAt: intent.createdAt,
            }),
          ]
        : [];
    const placed = placeStandIns(storedTurns, [...localSeeds, ...replyStandIns]);
    return opening.length ? [...opening, ...placed] : placed;
  }, [derivation?.state, intent, localSeeds, replyStandIns, storedTurns, threadId]);
  // Live announcements follow the server's replies: a Retry's stand-in speaks
  // for itself, and a lost one is not a failed run.
  const latestAssistantTurn =
    [...turns]
      .reverse()
      .find((turn) => turn.role === "assistant" && replyRetry.requestOf(turn.id) === null) ?? null;
  const isStreaming = latestAssistantTurn?.status === "streaming";
  // Only what the server has can be stopped: a stand-in brief is not a run yet.
  const { canStop: canStopSeed } = brief;
  const run = useMemo(
    () => composerRun(turns.filter((turn) => !isHandoffSeed(turn) || canStopSeed(turn))),
    [canStopSeed, turns],
  );
  const composerAgentName = activeThread?.agentName ?? "General";

  const pageTitle = activeThread?.title ? displayThreadTitle(activeThread.title) : t`New chat`;
  const referenceCatalog = useReferenceBrowserCatalog(
    projectId,
    activeWork?.id,
    t`Reference a file`,
    chatLineageId({ thread: activeThread, work: activeWork }),
  );
  const availableSkills = useThreadAvailableSkills(threadId);
  const activity = useThreadActivity({
    threadId,
    seed: snapshotLiveState,
  });
  const runningSubagents = activeChildren(activity.activity);
  const runningBackgroundSubagents = runningSubagents.filter(
    (node) => node.deliveryMode === "background_notification",
  );
  const pendingInbox = usePendingInbox({ threadId, seed: snapshotLiveState });
  const queuedWriterTurnIds = useMemo(
    () => selectQueuedWriterTurnIds(pendingInbox),
    [pendingInbox],
  );
  const answeredControls = useMemo(() => answeredControlIds(turns), [turns]);
  const controls = useThreadControls({
    threadId,
    pending: pendingInbox,
    answeredControlIds: answeredControls,
  });
  useControlTurnAnnouncements(turns);
  // The snapshot revalidates as a compaction reserves and settles, so its live
  // state is fresher here than the subscription seed.
  const liveStatus = snapshotLiveState?.status ?? activity.status;
  const { enqueue: enqueueControl } = controls;
  // `/compact` is always the command. A chat with nothing to summarize yet is
  // refused by the server, and that refusal shows on the command's own row.
  const chatCommands = useMemo<readonly ComposerChatCommand[]>(
    () => [
      {
        slug: "compact",
        name: t`Compact conversation`,
        description: t`Summarize earlier messages so the model has room to keep going`,
        run: (instructions) => {
          requestTailFollow();
          enqueueControl(instructions ? { kind: "compact", instructions } : { kind: "compact" });
        },
      },
    ],
    [enqueueControl],
  );

  // Only a primary the server already has can be forked or handed off; a
  // subagent's view offers neither (the server refuses both there).
  const canDerive = canDeriveFrom({
    kind: activeThread?.kind ?? null,
    pendingCreation,
    canOpen: openThread !== null,
  });
  const inheritedView = inherited.view;
  const turnDerivation = useMemo<TurnDerivation | null>(() => {
    if (!canDerive || !activeThread || !openThread) return null;
    const deps: DerivationDeps = { accountId, accountSignal, threadActions: actions };
    const base = {
      projectId,
      sourceThreadId: threadId,
      sourceTitle: activeThread.title,
      workId: activeWork?.id ?? activeThread.workId,
    };
    return {
      projectId,
      sourceAgent: {
        name: activeThread.agentName,
        definitionRevisionId: activeThread.agentDefinitionRevisionId,
      },
      fork: (originTurnId) => {
        startDerivation(
          {
            ...base,
            kind: "fork",
            originTurnId,
            agent: null,
            agentName: activeThread.agentName,
          },
          {
            ...deps,
            source: activeThread,
            inherited: optimisticForkPrefix({
              source: activeThread,
              sourceInherited: inheritedView,
              localTurns: storedTurns,
              cutoffTurnId: originTurnId,
            }),
            open: openThread,
          },
        );
      },
      handoff: (originTurnId, agent) => {
        startDerivation(
          { ...base, kind: "handoff", originTurnId, agent, agentName: agent.name },
          { ...deps, source: activeThread, inherited: null, open: openThread },
        );
      },
    };
  }, [
    accountId,
    accountSignal,
    actions,
    activeThread,
    activeWork?.id,
    canDerive,
    inheritedView,
    openThread,
    projectId,
    storedTurns,
    threadId,
  ]);

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
    activateProjection,
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
    // Durable witness before display and dispatch: a displayed action survives
    // reload only if the intent was persisted first. If the journal refuses the
    // write, do not show a row or dispatch — keep the draft and report failure.
    const epoch = getChatSubmissionEpoch();
    const recorded = recordChatSubmission(accountId, {
      kind: "existing-thread",
      submissionId: envelope.submissionId,
      threadId,
      projectId,
      createdAt: new Date().toISOString(),
      text: envelope.text,
      blocks: [...envelope.blocks],
      references: [...envelope.references],
      activatedSkillSlugs: [...envelope.activatedSkillSlugs],
      draft: envelope.draft,
    });
    if (!recorded) {
      return {
        kind: "rejected" as const,
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    }
    requestTailFollow();
    const optimisticUserTurn = actions.appendUserTurn(threadId, envelope.blocks);
    // Register the live row before the POST awaits admission: a thread remount
    // while the server still holds the lease must reuse it, not append a second
    // pending copy. Cleared below on acknowledgement or proved rejection.
    rememberSubmissionTurnId(accountId, envelope.submissionId, optimisticUserTurn.id);
    // A fork or handoff opened before the server had it: the message is shown
    // now and sent once the thread exists. If creation failed, the message
    // fails with it and keeps Retry.
    if (!(await whenDerived(threadId))) {
      submissionRecovery.markRejected(envelope.submissionId, optimisticUserTurn.id);
      return {
        kind: "rejected" as const,
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    }
    try {
      const outcome = await controller.submit(threadId, envelope, {
        optimisticUserTurnId: optimisticUserTurn.id,
        keepOptimisticOnFailure: true,
      });
      if (outcome.kind === "accepted") {
        if (settleChatSubmission(accountId, envelope.submissionId, "accepted", epoch))
          forgetSubmissionTurnId(accountId, envelope.submissionId);
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
    }
  }

  const focusRejectedMessage = useCallback(() => {
    composerRef.current?.focus();
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
        const retired =
          outcome.kind === "accepted"
            ? settleChatSubmission(accountId, envelope.submissionId, "accepted", epoch)
            : retireChatSubmission(accountId, envelope.submissionId, epoch);
        if (retired) forgetSubmissionTurnId(accountId, envelope.submissionId);
      } else if (outcome.kind === "rejected" && optimisticUserTurnId) {
        // A definitive rejection keeps the failed row with edit/retry recovery.
        submissionRecovery.markRejected(envelope.submissionId, optimisticUserTurnId);
      }
      return outcome;
    },
    [accountId, controller, submissionRecovery, threadId],
  );

  function handleStop() {
    // A compaction or brief has no reply stream for the run controller to
    // stop: cancel its turn, as the divider's and the card's own Stop do.
    if (run?.kind === "placeholder") {
      if (run.turn.role === "compaction") controls.stop(run.turn.id);
      else brief.stop(run.turn.id);
      return;
    }
    controller.cancel(threadId);
  }

  const handleRespondToInterrupt = useCallback(
    (request: InterruptRespondRequest) => controller.respondInterrupt(request),
    [controller],
  );

  const links = useChatLinkFollowing({ projectId, activeThread, activeWork, active });

  const submissionRecoveryByTurnId = new Map<string, UserTurnRecovery>();
  for (const entry of submissionRecovery.recovered) {
    submissionRecoveryByTurnId.set(entry.optimisticTurnId, {
      kind: "ambiguous",
      onCheck: () => submissionRecovery.check(entry.submissionId),
      onRetire: () => submissionRecovery.retire(entry.submissionId),
    });
  }
  for (const entry of submissionRecovery.rejected) {
    const draftIsRecoverable = Boolean(entry.fingerprint.draft);
    submissionRecoveryByTurnId.set(entry.optimisticTurnId, {
      kind: "rejected",
      onRetry: () => {
        void submissionRecovery.retry(entry.optimisticTurnId);
      },
      // Settlement already returned the structured words; Edit only focuses them.
      ...(draftIsRecoverable ? { onEdit: () => focusRejectedMessage() } : {}),
    });
  }

  return (
    <TranscriptLinkNavigationContext.Provider value={links.navigation}>
      <ReferenceAvailabilityContext.Provider value={links.references}>
        <ChatSurface
          title={pageTitle}
          surfaceRef={chatSurfaceRef}
          footer={
            <div data-debug-composer={threadId}>
              {composerStrip ? (
                // The composer's own border and radius, open at the bottom: the
                // composer's top border is the strip's lower edge, so the two
                // read as one unit. Inset like the draft dock below it.
                <div className="mx-[var(--chat-space-block)] rounded-t-composer-pinned border border-b-0 border-composer-border bg-composer-surface">
                  {composerStrip}
                </div>
              ) : null}
              {/* The dock strip sits BEHIND (below) the composer — narrower via
              mx-2, top corners rounded, jade-tinted background. The composer
              always keeps its own border and overlaps the strip's edge. */}
              <DraftDock dock={dock} />
              <Composer
                key={draft.key}
                initialDraft={draft.initialDraft}
                onDraftChange={draft.updateDraft}
                onOpenReference={(reference) => {
                  void openReferenceDocument({
                    documentId: reference.documentId,
                    disposition: "current",
                  });
                }}
                ref={composerRef}
                variant="pinned"
                running={run !== null}
                referenceCatalog={referenceCatalog}
                availableSkills={availableSkills.skills}
                commands={chatCommands}
                uploadPort={uploadIntakePort}
                uploadScope={
                  activeWork ? { kind: "work", projectId, workId: activeWork.id } : undefined
                }
                onSubmit={handleSubmit}
                onCheckSubmission={(envelope) => settleQuarantined(envelope, false)}
                onRetireSubmission={(envelope) => settleQuarantined(envelope, true)}
                onStop={handleStop}
                toolbarLeft={
                  activeWork ? (
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
          <TurnDerivationProvider value={turnDerivation}>
            <SubagentDisclosureProvider>
              <SubagentActivityProvider nodes={activity.activity.children} turns={turns}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <RunningSubagentsStrip threadId={threadId} />
                  <TurnList
                    threadId={threadId}
                    turns={turns}
                    awaitingSubagents={runningBackgroundSubagents.length > 0}
                    historySettled={historySettled}
                    tailFollowRevision={tailFollowRevision}
                    ariaLabel={t`Chat`}
                    onRespondToInterrupt={handleRespondToInterrupt}
                    failedSendRetry={failedSendRetry}
                    changeTrails={changeTrails.byId}
                    submissionRecoveryByTurnId={submissionRecoveryByTurnId}
                    queuedWriterTurnIds={queuedWriterTurnIds}
                    controls={controls}
                    brief={brief}
                    replyRetry={replyRetry}
                    busy={liveStatus.kind === "awake" || run !== null}
                    inherited={inheritedView}
                    onRetryInherited={inherited.failed ? inherited.retry : null}
                    threadUsage={snapshotThreadUsage}
                  />
                </div>
              </SubagentActivityProvider>
            </SubagentDisclosureProvider>
          </TurnDerivationProvider>
        </ChatSurface>
        <LinkFollowDialog {...links.dialog} />
      </ReferenceAvailabilityContext.Provider>
    </TranscriptLinkNavigationContext.Provider>
  );
}
