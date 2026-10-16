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
import type { ProjectId, UserId } from "@meridian/contracts";
import type { Thread, ThreadLiveState, Turn, Work } from "@meridian/contracts/protocol";
import {
  answeredControlIds,
  isHandoffSeed,
  type PendingInboxItem,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import {
  type ChatReferenceScope,
  type HandBackCard,
  handBackCards,
  hiddenWriterTurns,
  isAwaitingExecution,
  isBusy,
  switchState,
  usageBlockedMessages,
  viewTranscript,
  waitingWriterMessages,
} from "@meridian/thread-client";
import { chatMovedPast } from "@meridian/thread-client/view";
import { type ReactNode, useCallback, useMemo, useReducer, useRef } from "react";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { useThreadAvailableSkills } from "@/client/query/useAvailableSkills";
import { useLineage } from "@/client/query/useLineageTitle";
import {
  useIsThreadPendingCreation,
  useRunStateSlice,
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
import {
  displayedChatThreadId,
  useChatNavigation,
} from "@/features/project/routing/chat-navigation";
import { defaultThreadTitle, displayThreadTitle } from "@/lib/thread-title";
import { TranscriptLinkNavigationContext } from "@/rich-content/TranscriptReference";
import { ChatComposerToolbar } from "./ChatComposerToolbar";
import { ChatSurface } from "./ChatSurface";
import { useOpenChatThread } from "./ChatThreadNavigation";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { chatLineageId } from "./chat-scratch-owner";
import { useControlTurnAnnouncements } from "./compaction/useControlTurnAnnouncements";
import { composerRun } from "./composer-run";
import { DraftDock } from "./DraftDock";
import {
  canDeriveFrom,
  type TurnDerivation,
  TurnDerivationProvider,
} from "./derivation/DeriveTurnActions";
import {
  type DerivationDeps,
  startDerivation,
  useDerivationStatus,
} from "./derivation/derive-conversation";
import { optimisticHandoffSeed } from "./derivation/handoff-seed";
import { optimisticForkPrefix, useInheritedView } from "./derivation/inherited-view";
import { useHandoffBrief } from "./derivation/useHandoffBrief";
import { HandBackCards } from "./HandBackCards";
import { reportPersistedContractFailure } from "./persisted-contract-debug";
import { RunningSubagentsStrip } from "./RunningSubagentsStrip";
import { ReferenceAvailabilityContext } from "./reference-availability";
import { SubagentActivityProvider } from "./subagent/ActivityContext";
import { SubagentDisclosureProvider } from "./subagent/DisclosureStore";
import type { TurnQueueControls } from "./TurnList";
import { TurnList } from "./TurnList";
import { activeChildren } from "./thread-activity";
import { useSwitchView } from "./thread-controls/useSwitchView";
import { useThreadControls } from "./thread-controls/useThreadControls";
import { UsageBlockedNotice } from "./UsageBlockedNotice";
import { useChatLinkFollowing } from "./useChatLinkFollowing";
import { useChatStop } from "./useChatStop";
import { useChatSubmissions } from "./useChatSubmissions";
import { useChatThreadSession } from "./useChatThreadSession";
import { useComposerSessionDraft } from "./useComposerSessionDraft";
import { useDraftDock } from "./useDraftDock";
import { useHandBack } from "./useHandBack";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";
import { useQueueControls } from "./useQueueControls";
import { useReplyRetry } from "./useReplyRetry";
import { useSendNow } from "./useSendNow";
import { useThreadActivity } from "./useThreadActivity";
import { useThreadDurableProjections } from "./useThreadDurableProjections";
import { useThreadNavigationAnnounce } from "./useThreadNavigationAnnounce";

const EMPTY_TURNS: Turn[] = [];
const NO_ITEMS: PendingInboxItem[] = [];

export type ChatViewProps = {
  threadId: string;
  projectId: string;
  activeThread?: Thread | null;
  /** The rendered snapshot's write mode: the ledger's base, consistent with the transcript it reads. */
  snapshotWriteMode?: AiWriteMode;
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
  /** A notice framed onto the composer's top edge; the composer stays usable under it. */
  composerStrip?: ReactNode;
  /** False while the chat is mounted but hidden (collapsed dock, Settings). */
  active?: boolean;
};

export function ChatView({
  threadId,
  projectId,
  activeThread = null,
  snapshotWriteMode,
  activeWork = null,
  snapshotLiveState = null,
  snapshotThreadUsage = null,
  historySettled,
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
  const navigation = useChatNavigation();
  const pendingCreation = useIsThreadPendingCreation(threadId);
  const derivation = useDerivationStatus(threadId);
  const inherited = useInheritedView(activeThread, derivation?.inherited ?? null);
  const storedTurns = useThreadStore(
    (state) => state.syncedByThread[threadId]?.turns ?? EMPTY_TURNS,
  );
  const brief = useHandoffBrief({ threadId, storedTurns });
  const { view: runState, history } = useRunStateSlice(threadId);
  const replyRetry = useReplyRetry({ threadId, storedTurns });
  // A handoff's brief is on its way the moment the writer lands; until the
  // server's seed arrives the card stands in for it (it has nothing to stop
  // yet). A Retry's new card, or a failed reply's new reply, stands after the
  // turn it followed until the server has it.
  const intent = derivation?.intent;
  const { localSeeds } = brief;
  const { standIns: replyStandIns, retried: retriedReplies, refused: refusedReplies } = replyRetry;
  const refusedIds = useMemo(() => new Set(refusedReplies.keys()), [refusedReplies]);
  const activity = useThreadActivity({
    threadId,
    seed: snapshotLiveState,
  });
  const runningSubagents = activeChildren(activity.activity);
  const runningBackgroundSubagents = runningSubagents.filter(
    (node) => node.deliveryMode === "background_notification",
  );
  const queuedWriterTurnIds = useMemo(
    () => new Set(waitingWriterMessages(runState).map((item) => item.id)),
    [runState],
  );
  const hiddenTurnIds = useMemo(() => hiddenWriterTurns(runState), [runState]);
  const usageBlocked = usageBlockedMessages(runState).length > 0;
  const switchAwaitsRun = useMemo(
    () => switchState(runState)?.rows.some((row) => row.awaitsRun) ?? false,
    [runState],
  );
  const inheritedTranscript = inherited.view?.transcript ?? null;
  const opening = useMemo(
    () =>
      intent?.kind === "handoff" &&
      derivation?.state !== "failed" &&
      !storedTurns.some(isHandoffSeed)
        ? optimisticHandoffSeed({
            threadId,
            sourceThreadId: intent.sourceThreadId,
            sourceTitle: intent.sourceTitle,
            cutoffTurnId: intent.originTurnId,
            createdAt: intent.createdAt,
          })
        : null,
    [derivation?.state, intent, storedTurns, threadId],
  );
  const standIns = useMemo(() => [...localSeeds, ...replyStandIns], [localSeeds, replyStandIns]);
  const awaitingSubagents = runningBackgroundSubagents.length > 0;
  // Every decision about which rows the writer sees runs in the view model.
  const view = useMemo(
    () =>
      viewTranscript({
        turns: storedTurns,
        opening,
        inherited: inheritedTranscript,
        activity: { awaitingSubagents },
        standIns,
        queued: queuedWriterTurnIds,
        hidden: hiddenTurnIds,
        retried: retriedReplies,
        refused: refusedIds,
        switchAwaitsRun,
        onContractFailure: reportPersistedContractFailure,
      }),
    [
      awaitingSubagents,
      inheritedTranscript,
      storedTurns,
      opening,
      queuedWriterTurnIds,
      hiddenTurnIds,
      retriedReplies,
      refusedIds,
      standIns,
      switchAwaitsRun,
    ],
  );
  const { turns } = view;
  // Live announcements follow the server's replies: a Retry's stand-in speaks
  // for itself, and a lost one is not a failed run.
  const latestAssistantTurn =
    [...turns]
      .reverse()
      .find((turn) => turn.role === "assistant" && replyRetry.requestOf(turn.id) === null) ?? null;
  const isStreaming = latestAssistantTurn?.status === "streaming";
  // Only what the server has can be stopped: a stand-in brief is not a run yet.
  const { canStop: canStopSeed } = brief;
  // The record says the chat works or owes a reply; a message owed with no run, while the
  // record says the start is blocked on usage, leaves the composer idle.
  const working = isBusy(runState) && !(isAwaitingExecution(runState) && usageBlocked);
  const run = useMemo(
    () => composerRun(turns.filter((turn) => !isHandoffSeed(turn) || canStopSeed(turn))),
    [canStopSeed, turns],
  );
  const running = run !== null || working;
  const composerAgentName = activeThread?.agentName ?? "General";

  const pageTitle = activeThread?.title ? displayThreadTitle(activeThread.title) : t`New chat`;
  const referenceCatalog = useReferenceBrowserCatalog(
    projectId,
    activeWork?.id,
    t`Reference a file`,
    chatLineageId({ thread: activeThread, work: activeWork }),
  );
  const availableSkills = useThreadAvailableSkills(threadId);
  const submissions = useChatSubmissions(
    threadId,
    projectId,
    accountId,
    controller,
    actions,
    () => composerRef.current?.focus(),
    () => {
      navigation.forgetChat(threadId);
      void navigation.openNewChat(undefined, { replace: true });
    },
    {
      visible: active,
      title:
        !activeThread?.title?.trim() || activeThread.title.trim() === defaultThreadTitle()
          ? null
          : activeThread.title,
      leave: (moved) => {
        navigation.forgetChat(threadId);
        if (moved) void navigation.openNewChat(undefined, { replace: true });
        else if (displayedChatThreadId(navigation.display) === threadId)
          void navigation.openNewChat(undefined, { replace: true });
      },
    },
  );
  const answeredControls = useMemo(() => answeredControlIds(turns), [turns]);
  const switches = useSwitchView({
    threadId,
    projectId,
    writeMode:
      snapshotWriteMode ??
      activeThread?.effectiveAiWriteMode ??
      activeWork?.defaultAiWriteMode ??
      "direct",
    journal: submissions.switches,
    replyRunning: running,
  });
  const controls = useThreadControls({
    threadId,
    items: runState.record?.items ?? NO_ITEMS,
    version: runState.record?.version ?? null,
    history,
    answeredControlIds: answeredControls,
    switches,
  });
  useControlTurnAnnouncements(turns);
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
      aiWriteMode: activeThread.aiWriteMode,
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
    actions,
    isStreaming,
  });

  useLiveTurnAnnouncements(
    threadId,
    latestAssistantTurn,
    latestAssistantTurn !== null && chatMovedPast(turns)(latestAssistantTurn),
    composerRef,
    chatSurfaceRef,
  );

  // Generating signal: the latest assistant turn is streaming AND it started in
  // draft mode. A reply keeps the mode it started with while the chat's mode may
  // already be queued to change, so the running turn's own mode is the signal;
  // auto-apply streams never light the dock.
  const generating =
    isStreaming && (latestAssistantTurn?.writeMode ?? activeThread?.aiWriteMode) === "draft";
  const dock = useDraftDock({ threadId, generating });

  async function handleSubmit(envelope: ComposerSubmitEnvelope) {
    replyRetry.clearRefused();
    const recorded = await submissions.submit(envelope);
    if (recorded) requestTailFollow();
    return recorded;
  }

  const lineage = useLineage(
    projectId,
    activeThread ? { rootThreadId: activeThread.rootThreadId } : null,
  );
  const stopScope = useMemo<ChatReferenceScope | null>(
    () =>
      activeThread && activeWork
        ? {
            projectId: projectId as ProjectId,
            userId: accountId as UserId,
            work: { id: activeWork.id, slug: activeWork.slug },
            rootThreadId: activeThread.rootThreadId,
            rootThreadRef: lineage?.rootThreadRef ?? null,
          }
        : null,
    [accountId, activeThread, activeWork, lineage?.rootThreadRef, projectId],
  );
  const handBack = useHandBack({ threadId, accountId, scope: stopScope });
  const chatStop = useChatStop({ threadId, handBack });
  const queueControls = useQueueControls({ threadId, handBack });
  const sendNow = useSendNow(threadId);
  const { remove, cancelQueue } = queueControls;
  const { available: sendNowAvailable, busy: sendNowBusy, send: sendNowPress } = sendNow;
  const queue = useMemo<TurnQueueControls>(
    () => ({
      remove,
      cancelQueue,
      sendNow: { available: sendNowAvailable, busy: sendNowBusy, send: sendNowPress },
    }),
    [remove, cancelQueue, sendNowAvailable, sendNowBusy, sendNowPress],
  );
  const handBackCardList = useMemo(
    () =>
      handBackCards(
        [...handBack.unresolved, ...(sendNow.failed ? [sendNow.failed] : [])],
        runState,
      ),
    [handBack.unresolved, runState, sendNow.failed],
  );
  const retryCard = (card: HandBackCard) => {
    if (card.source.kind === "send-now") sendNow.retry();
    else void handBack.operation.retry(card.source.requestId);
  };
  const dismissCard = (card: HandBackCard) => {
    if (card.source.kind === "send-now") return sendNow.dismiss();
    handBack.operation.dismiss(card.source.requestId);
  };
  function handleStop() {
    // A brief being written holds the chat with no run: its own Stop. Everything else, a reply,
    // a compaction, the gap between replies, is the chat's Stop, decided on the server, and
    // the waiting messages it hands back arrive in the composer.
    if (run?.kind === "placeholder") brief.stop(run.turn.id);
    else chatStop.stop();
  }

  const handleRespondToInterrupt = useCallback(
    (request: InterruptRespondRequest) => controller.respondInterrupt(request),
    [controller],
  );

  const links = useChatLinkFollowing({ projectId, activeThread, activeWork, active });

  return (
    <TranscriptLinkNavigationContext.Provider value={links.navigation}>
      <ReferenceAvailabilityContext.Provider value={links.references}>
        <ChatSurface
          title={pageTitle}
          surfaceRef={chatSurfaceRef}
          footer={
            <div data-debug-composer={threadId}>
              <Composer
                notices={
                  usageBlocked || handBackCardList.length > 0 ? (
                    <>
                      {usageBlocked ? <UsageBlockedNotice /> : null}
                      <HandBackCards
                        cards={handBackCardList}
                        onRetry={retryCard}
                        onDismiss={dismissCard}
                      />
                    </>
                  ) : undefined
                }
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
                attached={
                  <>
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
                  </>
                }
                running={running}
                stopStatus={chatStop.status}
                referenceCatalog={referenceCatalog}
                availableSkills={availableSkills.skills}
                commands={chatCommands}
                uploadPort={uploadIntakePort}
                uploadScope={
                  activeWork ? { kind: "work", projectId, workId: activeWork.id } : undefined
                }
                onSubmit={handleSubmit}
                onStop={handleStop}
                toolbarLeft={
                  activeWork ? (
                    <ChatComposerToolbar
                      projectId={projectId}
                      threadId={threadId}
                      work={activeWork}
                      agentName={composerAgentName}
                      writeMode={controls.writeMode}
                      onWriteModeChange={controls.switchWriteMode}
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
                    view={view}
                    historySettled={historySettled}
                    tailFollowRevision={tailFollowRevision}
                    ariaLabel={t`Chat`}
                    onRespondToInterrupt={handleRespondToInterrupt}
                    changeTrails={changeTrails.byId}
                    submissionRecoveryByTurnId={submissions.presentation}
                    controls={controls}
                    chatStop={chatStop}
                    queue={queue}
                    brief={brief}
                    replyRetry={replyRetry}
                    busy={running}
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
