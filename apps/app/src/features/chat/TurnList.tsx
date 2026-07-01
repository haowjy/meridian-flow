/**
 * TurnList — the conversation transcript and the SINGLE scroll owner.
 *
 * One plain viewport is the only scroll container, with two clearly split owners:
 *   - `@tanstack/react-virtual` owns GEOMETRY: row layout/height (virtualized for
 *     long threads) and scrollTop compensation when a row ABOVE the viewport
 *     changes height (images load, disclosures expand), so the reader's place is
 *     preserved while scrolled up.
 *   - `useChatFollowScroll` owns POLICY: the explicit `follow | free` state
 *     machine. In `follow` every content revision (`getTotalSize()` change)
 *     re-pins the viewport to the live edge; in `free` nothing auto-scrolls. The
 *     jump-to-latest pill is visible iff `free`.
 * Geometry never doubles as policy state — deriving "at bottom" per-frame from
 * `isAtEnd()` is what made the pill flicker and follow-release feel inconsistent.
 * There is no second scroll engine and no nested scroller.
 *
 * Top inset and composer clearance are the virtualizer's own `paddingStart` /
 * `paddingEnd`, so "scrolled to the end" lines up exactly with the last turn resting
 * above the composer (the bottom inset is the measured composer height from
 * `ChatSurface`, via `useChatSurfaceBottomInset`).
 *
 * Rows are keyed by `turn.id`, so when the live assistant turn settles the same row
 * stays mounted and only its `Turn` data changes — no remount; expand/collapse and
 * scroll position survive (Stream S3 convergence).
 *
 * Draft anchoring: `draftsByTurnId` (computed by ChatView) hands per-turn
 * `ThreadDraftGroup[]` to assistant turns so the DraftReviewCard renders inside the
 * producing turn's row. A card inside a virtualized row cannot own a fixed-position
 * modal — the overlay lives at the (non-virtualized) ChatView root.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import { Button } from "@/components/ui/button";

import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import { useChatSurfaceBottomInset } from "./ChatSurface";
import type { CheckpointRespondRequest } from "./CustomBlockRenderer";
import { DraftAcceptTurn } from "./DraftAcceptTurn";
import { DraftRejectTurn } from "./DraftRejectTurn";
import { isDraftAcceptTurn } from "./draft-accept-turn";
import { isDraftRejectTurn } from "./draft-reject-turn";
import { UserTurn } from "./UserTurn";
import { useChatFollowScroll } from "./useChatFollowScroll";
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
/** Top breathing room above the first turn (virtual paddingStart, px). */
const TOP_INSET = 24;

/**
 * react-virtual@3.14's option type omits virtual-core@3.17's
 * `shouldAdjustScrollPositionOnItemSizeChange` (present at runtime). Widen it so
 * the anchoring predicate is type-checked rather than cast to `any`.
 */
type TurnVirtualizerOptions = Parameters<typeof useVirtualizer<HTMLDivElement, Element>>[0] & {
  shouldAdjustScrollPositionOnItemSizeChange?: (item: VirtualItem) => boolean;
};

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
  const bottomInset = useChatSurfaceBottomInset();
  const visibleTurns = useMemo(() => filterVisibleTurns(turns), [turns]);
  const lastAssistantIdx = findLastAssistantIndex(visibleTurns);

  // react-virtual@3.14's option TYPE predates virtual-core@3.17's
  // `shouldAdjustScrollPositionOnItemSizeChange`, but the installed core (3.17.2)
  // supports it at runtime. Widen the options type so we can pass it type-safely.
  const virtualizerOptions: TurnVirtualizerOptions = {
    count: visibleTurns.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => visibleTurns[index]?.id ?? index,
    overscan: 8,
    paddingStart: TOP_INSET,
    // Clear the pinned composer AND align the true scroll end with the last turn.
    paddingEnd: bottomInset,
    // Preserve the reader's place when a row ABOVE the viewport changes height (a
    // disclosure expands, an image/code block renders). virtual-core's default
    // compensates first-measurement but SKIPS re-measurement while `scrollDirection`
    // is "backward" — which persists after a scroll-up, so expanding settled content
    // above would jump the view. Compensate for every above-viewport size change.
    // `scrollTop` is the scroll offset; a row starting above it is off the top.
    shouldAdjustScrollPositionOnItemSizeChange: (item: VirtualItem) =>
      item.start < (viewportRef.current?.scrollTop ?? 0),
  };
  const virtualizer = useVirtualizer(virtualizerOptions);

  // Follow policy. `getTotalSize()` is the content revision: it changes on turn
  // append, on measured streaming-row growth, and on composer-inset change — and
  // each change re-renders this component, so the follow pin fires before paint.
  // The thread opens in `follow`, so the very first pin anchors to the newest turn.
  const { mode, enterFollow } = useChatFollowScroll({
    scrollRef: viewportRef,
    contentRevision: virtualizer.getTotalSize(),
  });

  // Reacquire follow when the user submits (each local message bumps the revision).
  useEffect(() => {
    if (tailFollowRevision === 0) return;
    enterFollow("smooth");
  }, [tailFollowRevision, enterFollow]);

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        role="log"
        aria-label={ariaLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: transcript is a scroll region — focusable so keyboard users can scroll it (arrows/PageUp/Down).
        tabIndex={0}
        // overflow-x-hidden: `overflow-y:auto` forces the x-axis from `visible` to
        // `auto` (CSS spec), giving an implicit horizontal scroll/rubber-band range we
        // never want — code blocks scroll internally. min-w-0 keeps children from
        // widening the flex column.
        // [overflow-anchor:none]: the virtualizer is the single scroll owner and does
        // its own scrollTop compensation for above-viewport resizes; browser native
        // scroll anchoring would be a competing second owner, double-correcting and
        // leaving the reader's place off. Disable it so TanStack alone drives scroll.
        className="chat-scroll-fade-bottom size-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]"
      >
        <ChatColumn>
          <ol
            aria-label="Conversation turns"
            data-chat-virtual-list
            data-settled-turn-count={visibleTurns.length}
            className="relative w-full list-none"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const turn = visibleTurns[virtualItem.index];
              if (!turn) return null;
              return (
                <li
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  data-chat-turn-row="settled"
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 pb-6"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderTurn(turn, virtualItem.index)}
                </li>
              );
            })}
          </ol>
        </ChatColumn>
      </div>

      <JumpToLatestButton
        hidden={mode === "follow"}
        bottomInset={bottomInset}
        // Instant jump: mode flips to follow synchronously inside enterFollow, so
        // the pill hides the same frame the viewport lands at the live edge.
        onClick={() => enterFollow("auto")}
      />
    </div>
  );
}

/**
 * Jump-to-latest pill. Sits above the pinned composer (offset by the measured
 * composer height) and fades out while the reader is following the live edge.
 */
function JumpToLatestButton({
  hidden,
  bottomInset,
  onClick,
}: {
  hidden: boolean;
  bottomInset: number;
  onClick: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center transition-[opacity,translate] duration-200 data-[hidden=true]:translate-y-full data-[hidden=true]:opacity-0"
      data-hidden={hidden}
      style={{ bottom: bottomInset + 12 }}
    >
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        onClick={onClick}
        tabIndex={hidden ? -1 : 0}
        aria-hidden={hidden}
        className="pointer-events-auto rounded-full border border-border shadow-button"
      >
        <ArrowDownIcon />
        <span className="sr-only">Scroll to latest</span>
      </Button>
    </div>
  );
}

/** Index of the last assistant turn in `turns`, or -1 if none. */
function findLastAssistantIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return i;
  }
  return -1;
}
