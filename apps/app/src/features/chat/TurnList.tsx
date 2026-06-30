/**
 * TurnList — the conversation scroller: one message-scroller viewport that owns
 * all scroll/follow behavior, with TanStack Virtual rows keyed by `turn.id`.
 *
 * Single source of truth for scrolling. The `@shadcn/react` message-scroller owns
 * follow: it stays pinned to the live edge while the reader is at the bottom, and
 * RELEASES follow the moment they scroll up (wheel/touch/keyboard/drag) — streamed
 * chunks then arrive without yanking them back. We virtualize the rows ourselves so
 * long threads stay performant; the primitive only sees the viewport.
 *
 * Rows are keyed by `turn.id`, so when the live assistant turn settles the same row
 * stays mounted and only its `Turn` data changes — no remount, expand/collapse and
 * scroll position survive (Stream S3 convergence; see `useChatThreadSession`).
 *
 * Draft anchoring: `draftsByTurnId` (computed by ChatView from `useThreadDrafts`)
 * hands per-turn `ThreadDraftGroup[]` arrays to assistant turns so the
 * DraftReviewCard renders inside the producing turn's row. The lookup stays in the
 * parent so most rows get `undefined` (memo stays stable). A card inside a
 * virtualized row CANNOT own a fixed-position modal — when the virtualizer recycles
 * the row the modal vanishes with it; the card calls the shared draft-review
 * controller and the overlay lives at the (non-virtualized) ChatView root.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";

import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import type { CheckpointRespondRequest } from "./CustomBlockRenderer";
import { DraftAcceptTurn } from "./DraftAcceptTurn";
import { DraftRejectTurn } from "./DraftRejectTurn";
import { isDraftAcceptTurn } from "./draft-accept-turn";
import { isDraftRejectTurn } from "./draft-reject-turn";
import { UserTurn } from "./UserTurn";
import type { DraftReviewController } from "./useDraftReviewController";
import { filterVisibleTurns } from "./visible-chat-turns";

export type TurnListProps = {
  threadId: string;
  /** Settled history with the live turn merged in by id, oldest first. */
  turns: Turn[];
  /** Monotonic submit signal: new local messages intentionally reacquire tail-follow. */
  tailFollowRevision: number;
  /** Accessible label for the scroll log region. */
  ariaLabel: string;
  onRespondToCheckpoint?: (request: CheckpointRespondRequest) => void;
  /** Active AI draft groups keyed by the assistant turn that produced them. */
  draftsByTurnId?: Map<string, ThreadDraftGroup[]>;
  /** Shared draft review state machine owned by ChatView. */
  draftReviewController?: DraftReviewController;
};

/** Estimated row height before measurement; corrected by `measureElement`. */
const ESTIMATED_TURN_HEIGHT = 160;

export function TurnList({
  threadId,
  turns,
  tailFollowRevision,
  ariaLabel,
  onRespondToCheckpoint,
  draftsByTurnId,
  draftReviewController,
}: TurnListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const visibleTurns = useMemo(() => filterVisibleTurns(turns), [turns]);
  const lastAssistantIdx = findLastAssistantIndex(visibleTurns);

  const virtualizer = useVirtualizer({
    count: visibleTurns.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => visibleTurns[index]?.id ?? index,
    overscan: 8,
    // The list starts below the column's top padding; offset measurements so
    // virtual positions are relative to the list element, not the viewport top.
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const { scrollMargin } = virtualizer.options;

  const renderTurn = useCallback(
    (turn: Turn, idx: number) => {
      if (isDraftAcceptTurn(turn)) {
        return <DraftAcceptTurn threadId={threadId} turn={turn} />;
      }
      if (isDraftRejectTurn(turn)) {
        return <DraftRejectTurn turn={turn} />;
      }
      if (turn.role === "user") {
        return <UserTurn turn={turn} />;
      }
      // Lookup is per-row so most assistant turns get undefined (memo stable);
      // only turns with anchored drafts re-render when the map identity flips.
      const draftGroups = draftsByTurnId?.get(turn.id);
      const rowDraftReviewController = draftGroups?.length ? draftReviewController : undefined;
      return (
        <AssistantTurn
          threadId={threadId}
          turn={turn}
          isLatestAssistant={idx === lastAssistantIdx}
          onRespondToCheckpoint={onRespondToCheckpoint}
          draftGroups={draftGroups}
          draftReviewController={rowDraftReviewController}
        />
      );
    },
    [draftReviewController, draftsByTurnId, lastAssistantIdx, onRespondToCheckpoint, threadId],
  );

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport
          ref={viewportRef}
          role="log"
          aria-label={ariaLabel}
          className="chat-scroll-fade-bottom"
        >
          {/* Vertical padding lives on Content (not a nested child) because the
              primitive reads Content's own padding to size its end spacer and
              compute "at end" — so the bottom clearance that keeps the last turn
              above the pinned composer also counts as the true scroll end, and
              the jump-to-latest pill hides when pinned. --chat-footer-clearance
              is the composer footer's measured height (published by ChatSurface,
              variable: composer growth + unanchored-drafts strip). */}
          <MessageScrollerContent className="block pt-6 pb-[calc(var(--chat-footer-clearance,9rem)+1.5rem)]">
            <ChatColumn>
              <ol
                ref={listRef}
                aria-label="Conversation turns"
                data-chat-virtual-list
                data-settled-turn-count={visibleTurns.length}
                className="relative w-full list-none"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualItems.map((virtualItem) => {
                  const turn = visibleTurns[virtualItem.index];
                  if (!turn) return null;
                  return (
                    <li
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      data-chat-turn-row="settled"
                      ref={virtualizer.measureElement}
                      className="absolute inset-x-0 top-0 pb-6"
                      style={{
                        transform: `translateY(${virtualItem.start - scrollMargin}px)`,
                      }}
                    >
                      {renderTurn(turn, virtualItem.index)}
                    </li>
                  );
                })}
              </ol>
            </ChatColumn>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* Lift the jump-to-latest pill above the pinned composer, which paints
            over the bottom of this same body. --chat-footer-clearance is the
            composer footer's measured height (published by ChatSurface). */}
        <MessageScrollerButton className="bottom-[calc(var(--chat-footer-clearance,9rem)+0.75rem)]" />
        <TailFollowController revision={tailFollowRevision} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * Reacquires tail-follow when the user submits. `tailFollowRevision` bumps on each
 * local message; `scrollToEnd` snaps to the bottom and re-engages follow-output.
 */
function TailFollowController({ revision }: { revision: number }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (revision === 0) return;
    scrollToEnd({ behavior: "smooth" });
  }, [revision, scrollToEnd]);
  return null;
}

/** Index of the last assistant turn in `turns`, or -1 if none. */
function findLastAssistantIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return i;
  }
  return -1;
}
