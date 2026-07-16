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
 * transcript. `draftTurnIds` is only a cosmetic hint so a draft-producing turn's
 * write tool rows read "Drafted".
 *
 * Reads AI-draft review state from `DraftReviewProvider`; the dock and the
 * editor bar share one controller so preview selection cannot drift.
 */
import { t } from "@lingui/core/macro";
import type { Thread, ThreadLiveState, Turn, Work } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announceError, useThreadActions, useThreadStore } from "@/client/stores";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import { ComposerAgentControl } from "@/features/agents/ComposerAgentControl";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";

import { ChatSurface } from "./ChatSurface";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";
import { ComposerWriteModeControl } from "./ComposerWriteModeControl";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { DraftDock, useDraftDock } from "./DraftDock";
import { useDraftReview } from "./DraftReviewProvider";
import { TurnList } from "./TurnList";
import { useChatThreadSession } from "./useChatThreadSession";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";
import { useThreadChangeTrails } from "./useThreadChangeTrails";
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
};

export function ChatView({
  threadId,
  projectId = null,
  activeThread = null,
  activeWork = null,
  snapshotLiveState = null,
  snapshotNextSeq = null,
}: ChatViewProps) {
  const actions = useThreadActions();
  const changeTrails = useThreadChangeTrails(threadId);
  const queryClient = useQueryClient();
  const composerRef = useRef<ComposerHandle>(null);
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const [tailFollowRevision, requestTailFollow] = useReducer((value: number) => value + 1, 0);

  const controller = useMeridianAgent();
  const turns = useThreadStore((state) => state.turnsByThread[threadId] ?? EMPTY_TURNS);
  const latestAssistantTurn =
    [...turns].reverse().find((turn) => turn.role === "assistant") ?? null;
  const isStreaming = latestAssistantTurn?.status === "streaming";
  const threadStarted = (activeThread?.turnCount ?? turns.length) > 0;
  const boundAgentSlug = activeThread?.currentAgent ?? DEFAULT_AGENT_SLUG;
  const [draftAgentSlug, setDraftAgentSlug] = useState(DEFAULT_AGENT_SLUG);
  useEffect(() => {
    setDraftAgentSlug(activeThread?.currentAgent ?? DEFAULT_AGENT_SLUG);
  }, [activeThread?.currentAgent]);
  const composerAgentSlug = threadStarted ? boundAgentSlug : draftAgentSlug;

  const pageTitle = activeThread?.title ? displayThreadTitle(activeThread.title) : t`New chat`;

  useThreadNavigationAnnounce(threadId, pageTitle, composerRef);

  useChatThreadSession({
    threadId,
    projectId,
    controller,
    actions,
    isStreaming,
  });

  useThreadHandoff(threadId, controller, actions, {
    liveState: snapshotLiveState,
    nextSeq: snapshotNextSeq,
  });
  useLiveTurnAnnouncements(threadId, latestAssistantTurn, composerRef, chatSurfaceRef);

  const { drafts } = useDraftReview();
  const draftMode = activeWork?.aiWriteMode === "draft";
  // Generating signal: the current thread's latest assistant turn is streaming
  // AND the Work is in draft mode. That is the cleanest "this streaming turn is
  // producing draft edits" signal available client-side (per-turn draft lineage
  // is a later server phase); auto-apply streams never light the dock.
  const generating = isStreaming && draftMode;
  const dock = useDraftDock({ generating });

  // Cosmetic hint: turns that produced an AI draft render "Drafted" on write
  // tool rows. Derived from the draft list's `lastActorTurnId`, keyed off the
  // draft identities so streaming/block churn doesn't rebuild the set.
  const draftTurnKey = (drafts.groups ?? [])
    .flatMap((group) => group.drafts.map((draft) => draft.lastActorTurnId))
    .filter((id): id is string => Boolean(id))
    .join("|");
  const draftTurnIds = useMemo<ReadonlySet<string>>(
    () => new Set(draftTurnKey.length > 0 ? draftTurnKey.split("|") : []),
    [draftTurnKey],
  );

  async function handleSubmit(text: string) {
    requestTailFollow();
    const optimisticUserTurn = actions.appendUserTurn(threadId, text);

    // The PRIOR assistant turn may have errored and the projector clears it
    // off `status:error` when the next user turn arrives — a side-effect with
    // no journal/WS event. Pull the refreshed snapshot now so the error
    // banner disappears without a reload. (Fix A2.)
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });

    try {
      await controller.submit(threadId, text, { optimisticUserTurnId: optimisticUserTurn.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit message";
      announceError(message);
    }
  }

  function handleStop() {
    controller.cancel(threadId);
  }

  const handleRespondToInterrupt = useCallback(
    (request: InterruptRespondRequest) => controller.respondInterrupt(request),
    [controller],
  );

  return (
    <ChatSurface
      title={pageTitle}
      surfaceRef={chatSurfaceRef}
      footer={
        <div
          data-debug-composer={threadId}
          // The dock is chrome on top of the composer: when mounted, the two
          // share ONE bordered, rounded, container-query box (radius/border here,
          // Composer runs flush). Empty → the composer keeps its own box.
          className={cn(
            "@container",
            dock.mounted &&
              "overflow-hidden rounded-composer-pinned border border-composer-border transition-[border-color] focus-within:border-border-focus",
          )}
        >
          <DraftDock dock={dock} />
          <Composer
            ref={composerRef}
            variant="pinned"
            flush={dock.mounted}
            placeholder={t`Reply to the agent, or steer the analysis…`}
            streaming={isStreaming}
            onSubmit={handleSubmit}
            onStop={handleStop}
            toolbarLeft={
              <>
                {threadStarted ? (
                  <ComposerAgentControl
                    projectId={projectId ?? null}
                    mode="readonly"
                    selectedSlug={composerAgentSlug}
                  />
                ) : (
                  <ComposerAgentControl
                    projectId={projectId ?? null}
                    mode="interactive"
                    selectedSlug={composerAgentSlug}
                    onSelectedSlugChange={setDraftAgentSlug}
                  />
                )}
                {projectId && activeWork ? (
                  <ComposerWriteModeControl projectId={projectId} work={activeWork} />
                ) : null}
              </>
            }
          />
        </div>
      }
    >
      <TurnList
        threadId={threadId}
        turns={turns}
        tailFollowRevision={tailFollowRevision}
        ariaLabel={t`Chat`}
        onRespondToInterrupt={handleRespondToInterrupt}
        draftTurnIds={draftTurnIds}
        changeTrails={changeTrails.byId}
      />
    </ChatSurface>
  );
}
