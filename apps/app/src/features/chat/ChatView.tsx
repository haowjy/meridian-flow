/**
 * ChatView — the full conversation view for a thread (project chat and the
 * independent `/chat/:threadId` surface).
 *
 * Composition root for the chat feature: reads canonical turns directly from
 * ThreadStore, wires snapshot sync, handoff, announcements, autoscroll hooks,
 * and renders `ChatSurface` + `TurnList` + `Composer`.
 *
 * Owns the AI-draft anchoring split (see `splitDraftGroupsByTurn`): hands the
 * per-turn map to `TurnList` for inline cards under the producing turn, and
 * renders the unanchored-drafts fallback strip directly above the Composer.
 *
 * Reads AI-draft review state from `DraftReviewProvider`; chat cards and the
 * editor bar share one controller so preview selection and overlap-confirm
 * state cannot drift.
 */
import { t } from "@lingui/core/macro";
import type { Thread, ThreadLiveState, Turn } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announceError, useThreadActions, useThreadStore } from "@/client/stores";
import { DEFAULT_AGENT_SLUG } from "@/features/agents";
import type { ChatPlacement } from "@/features/project/chat/ChatSurface";
import { displayThreadTitle } from "@/lib/thread-title";

import { splitDraftGroupsByTurn } from "./anchor-drafts";
import { ChatSurface } from "./ChatSurface";
import type { ComposerHandle } from "./Composer";
import { Composer } from "./Composer";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { DraftPreviewOverlay } from "./DraftPreviewOverlay";
import { DraftReviewCard } from "./DraftReviewCard";
import { useDraftReview } from "./DraftReviewProvider";
import { TurnList } from "./TurnList";
import { useChatThreadSession } from "./useChatThreadSession";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";
import { useThreadHandoff } from "./useThreadHandoff";
import { useThreadNavigationAnnounce } from "./useThreadNavigationAnnounce";

const EMPTY_TURNS: Turn[] = [];

export type ChatViewProps = {
  threadId: string;
  projectId?: string | null;
  activeThread?: Thread | null;
  snapshotLiveState?: ThreadLiveState | null;
  snapshotNextSeq?: string | null;
  /** Center vs dock — dock uses the compact agent chip in the composer footer. */
  placement?: ChatPlacement;
};

export function ChatView({
  threadId,
  projectId = null,
  activeThread = null,
  snapshotLiveState = null,
  snapshotNextSeq = null,
  placement = "center",
}: ChatViewProps) {
  const actions = useThreadActions();
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
  const composerAgentMode = threadStarted ? "readonly" : "interactive";

  const pageTitle = activeThread?.title
    ? displayThreadTitle(activeThread.title)
    : t`New conversation`;

  useThreadNavigationAnnounce(threadId, pageTitle, composerRef);

  const { scrollParent, scrollRef } = useChatThreadSession({
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

  const { controller: draftReview, drafts } = useDraftReview();

  // The transcript turn objects are recreated on every streaming tick, but
  // for anchoring all we care about is "is this turn id in the transcript?".
  // Collapse to a joined string of ids (cheap) and rebuild the set only when
  // the id list changes — so streaming/block churn does not bust the
  // anchored-card memoization down the row tree.
  const turnIdsKey = turns.map((turn) => turn.id).join("|");
  const turnIdSet = useMemo<ReadonlySet<string>>(
    () => new Set(turnIdsKey.length > 0 ? turnIdsKey.split("|") : []),
    [turnIdsKey],
  );
  const { byTurnId: draftsByTurnId, unanchored: unanchoredDrafts } = useMemo(
    () => splitDraftGroupsByTurn(drafts.groups, turnIdSet),
    [drafts.groups, turnIdSet],
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
    <>
      <ChatSurface
        title={pageTitle}
        surfaceRef={chatSurfaceRef}
        scrollRef={scrollRef}
        scrollAriaLabel={t`Conversation`}
        scrollClassName="pt-6"
        scrollFadeBottom
        footer={
          <div data-debug-composer={threadId} className="flex flex-col gap-2">
            {unanchoredDrafts.length > 0 ? (
              <div data-unanchored-drafts className="flex flex-col gap-2">
                {unanchoredDrafts.map((group) => (
                  <DraftReviewCard
                    key={group.documentId}
                    group={group}
                    controller={draftReview}
                    variant="compact"
                  />
                ))}
              </div>
            ) : null}
            <Composer
              ref={composerRef}
              variant="pinned"
              placeholder={t`Reply to the agent, or steer the analysis…`}
              streaming={isStreaming}
              onSubmit={handleSubmit}
              onStop={handleStop}
              agent={{
                projectId: projectId ?? null,
                mode: composerAgentMode,
                selectedSlug: composerAgentSlug,
                onSelectedSlugChange: setDraftAgentSlug,
                compact: placement === "dock",
              }}
            />
          </div>
        }
      >
        <TurnList
          threadId={threadId}
          turns={turns}
          scrollParent={scrollParent}
          tailFollowRevision={tailFollowRevision}
          onRespondToInterrupt={handleRespondToInterrupt}
          draftsByTurnId={draftsByTurnId}
          draftReviewController={draftReview}
        />
      </ChatSurface>

      <DraftPreviewOverlay />
    </>
  );
}
