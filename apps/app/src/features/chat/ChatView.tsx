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
import { Trans } from "@lingui/react/macro";
import type { Thread, ThreadLiveState, Turn, Work } from "@meridian/contracts/protocol";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { useOpenChatThread } from "./ChatThreadNavigation";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { requestConversationReveal } from "./conversation-reveal";
import { DraftDock, useDraftDock } from "./DraftDock";
import { queuedWriterTurnIds as selectQueuedWriterTurnIds } from "./pending-inbox";
import { RunningSubagentsStrip } from "./RunningSubagentsStrip";
import { canRestoreRejectedDraft, restoreRejectedDraft } from "./rejected-draft";
import { SubagentActivityProvider } from "./SubagentActivityContext";
import { SubagentMark } from "./SubagentMark";
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

function SubagentHeader({
  threadId,
  running,
  all,
}: {
  threadId: string;
  running: ThreadActivityNode[];
  all: ThreadActivityNode[];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const openThread = useOpenChatThread();
  const ordered = [...all].sort(
    (a, b) => Number(b.status.kind === "awake") - Number(a.status.kind === "awake"),
  );
  const visible = ordered.filter((node) =>
    `${node.agentName ?? ""} ${node.title ?? ""}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase()),
  );

  return (
    <div className="relative z-20 bg-background">
      {all.length ? (
        <div className="flex h-9 items-center justify-end px-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="focus-ring inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Users className="size-3.5" aria-hidden />
            <span>
              <Trans>Subagents</Trans> {all.length}
            </span>
            {running.length ? (
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            ) : null}
            <ChevronDown className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}
      {open && all.length ? (
        <div className="absolute right-3 top-8 z-30 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-background p-2 shadow-lg">
          <label className="sr-only" htmlFor="subagent-filter">
            <Trans>Filter subagents</Trans>
          </label>
          <input
            id="subagent-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t`Filter subagents`}
            className="focus-ring mb-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
          <ul className="max-h-72 overflow-y-auto">
            {visible.map((node) => {
              const name = node.agentName?.trim() || node.title?.trim() || "Subagent";
              const isRunning = node.status.kind === "awake";
              return (
                <li
                  key={node.threadId}
                  className="flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted"
                >
                  <SubagentMark
                    name={name}
                    status={
                      isRunning ? "running" : node.spawnStatus === "cancelled" ? "stopped" : "done"
                    }
                    className="size-5 text-[10px]"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {name}
                    {node.title && node.title !== name ? (
                      <span className="ml-1 text-muted-foreground">{node.title}</span>
                    ) : null}
                    {isRunning && node.currentTool ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {node.currentTool.toolName.replaceAll("_", " ")}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (node.originTurnId) {
                        requestConversationReveal({
                          kind: "turn",
                          threadId,
                          turnId: node.originTurnId,
                        });
                      }
                      window.setTimeout(
                        () => {
                          const target = [
                            ...document.querySelectorAll<HTMLElement>("[data-subagent-thread-id]"),
                          ]
                            .filter((element) => element.dataset.subagentThreadId === node.threadId)
                            .at(-1);
                          target?.scrollIntoView({ behavior: "smooth", block: "center" });
                          if (target) {
                            target.classList.add("motion-safe:animate-pulse");
                            window.setTimeout(
                              () => target.classList.remove("motion-safe:animate-pulse"),
                              900,
                            );
                          }
                        },
                        node.originTurnId ? 250 : 0,
                      );
                      setOpen(false);
                    }}
                    className="focus-ring rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Trans>Show</Trans>
                  </button>
                  {openThread ? (
                    <button
                      type="button"
                      onClick={() => openThread(node.threadId)}
                      className="focus-ring rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Trans>Open</Trans>
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {running.length ? <RunningSubagentsStrip descendants={running} /> : null}
    </div>
  );
}

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
  activateProjection: (after?: string) => boolean;
};

export function ChatView({
  threadId,
  projectId = null,
  activeThread = null,
  activeWork = null,
  snapshotLiveState = null,
  snapshotNextSeq = null,
  historySettled,
  activateProjection,
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
  const directSubagents = activity.activity.descendants.filter(
    (node) => node.parentThreadId === threadId,
  );
  const runningBackgroundSubagents = runningSubagents.filter(
    (node) => node.parentThreadId === threadId && node.deliveryMode === "background_notification",
  );
  const pendingInbox = usePendingInbox({ threadId, seed: snapshotLiveState });
  const queuedWriterTurnIds = useMemo(
    () => selectQueuedWriterTurnIds(pendingInbox),
    [pendingInbox],
  );

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
          <SubagentHeader
            threadId={threadId}
            running={runningBackgroundSubagents}
            all={directSubagents}
          />
        }
        footer={
          <div data-debug-composer={threadId}>
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
        <SubagentActivityProvider nodes={activity.activity.descendants}>
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
            queuedWriterTurnIds={queuedWriterTurnIds}
          />
        </SubagentActivityProvider>
      </ChatSurface>
    </TranscriptLinkNavigationContext.Provider>
  );
}
