/** Renders the transcript and owns its scroll viewport. */
import type { Turn } from "@meridian/contracts/protocol";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { Button } from "@/components/ui/button";
import { AssistantTurn } from "./AssistantTurn";
import { ChatColumn } from "./ChatColumn";
import { useChatSurfaceBottomInset } from "./ChatSurface";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
import { UserTurn, type UserTurnRecovery } from "./UserTurn";
import { useChangeTrailNavigation } from "./useChangeTrailNavigation";
import { useChatFollowScroll } from "./useChatFollowScroll";
import type { FailedSendRetry } from "./useThreadHandoff";
import { useTurnRevealLanding } from "./useTurnRevealLanding";
import { filterVisibleTurns } from "./visible-chat-turns";

export type TurnListProps = {
  threadId: string;
  /** Settled history with the live turn merged in by id, oldest first. */
  turns: Turn[];
  historySettled: boolean;
  /** Monotonic submit signal: new local messages intentionally reacquire tail-follow. */
  tailFollowRevision: number;
  /** Accessible label for the scroll log region. */
  ariaLabel: string;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  failedSendRetry?: FailedSendRetry | null;
  changeTrails?: Record<string, ChangeTrailShell>;
  /** Recovered ambiguous submissions, keyed by the restored user turn id. */
  submissionRecoveryByTurnId?: ReadonlyMap<string, UserTurnRecovery>;
  queueStatusByTurnId?: ReadonlyMap<string, "queued" | "waiting">;
};

/** Estimated row height before measurement; corrected by `measureElement`. */
const ESTIMATED_TURN_HEIGHT = 160;
/** Top breathing room above the first turn (virtual paddingStart, px). */
const TOP_INSET = 24;

export function TurnList({
  threadId,
  turns,
  historySettled,
  tailFollowRevision,
  ariaLabel,
  onRespondToInterrupt,
  failedSendRetry = null,
  changeTrails = {},
  submissionRecoveryByTurnId,
  queueStatusByTurnId,
}: TurnListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const navigateToChange = useChangeTrailNavigation(threadId);
  const bottomInset = useChatSurfaceBottomInset();
  const visibleTurns = useMemo(
    () => filterVisibleTurns(turns, queueStatusByTurnId),
    [queueStatusByTurnId, turns],
  );
  const lastAssistantIdx = findLastAssistantIndex(visibleTurns);
  const byTurnId = useMemo(() => {
    const byTurnId = new Map<string, ChangeTrailShell>();
    for (const shell of Object.values(changeTrails)) {
      if (shell.owner.kind === "turn") byTurnId.set(shell.owner.turnId, shell);
    }
    return byTurnId;
  }, [changeTrails]);

  const virtualizer = useVirtualizer({
    count: visibleTurns.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => visibleTurns[index]?.id ?? index,
    overscan: 8,
    paddingStart: TOP_INSET,
    // Clear the pinned composer AND align the true scroll end with the last turn.
    paddingEnd: bottomInset,
  });

  // Preserve the reader's place when a row ENTIRELY above the viewport changes
  // height (a disclosure expands, an image/code block renders). Two traps here:
  //   1. This is an INSTANCE property in virtual-core@3.17, not an option —
  //      passing it in the options object is silently ignored (react-virtual's
  //      option type omits it for the same reason). Assign it on the instance.
  //   2. The row must be FULLY above (`item.end`, not the default `item.start`):
  //      a straddling row grows below the reader's eyes (the streaming tail row
  //      while scrolled a short way up inside it), and compensating that growth
  //      slides the view back down toward the live edge — a creep that silently
  //      re-captures follow. `item` carries the pre-resize measurement, which is
  //      exactly what "was it above the viewport" should be judged against.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item: VirtualItem) =>
    item.end <= (viewportRef.current?.scrollTop ?? 0);

  // Turn stage of a conversation reveal. The transcript owns the landing (and
  // the verdict when the turn isn't here); the scroll capability stays here.
  useTurnRevealLanding({
    threadId,
    turns: visibleTurns,
    historySettled,
    viewportRef,
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: "center" }),
  });

  // Follow policy. `getTotalSize()` is the content height AND the revision: it is
  // the height the virtualized list scrolls over, and it changes on turn append,
  // on measured streaming-row growth, and on composer-inset change — each change
  // re-renders this component, so the follow pin fires before paint. Passing the
  // height (not a bare counter) lets the pin compute the bottom without reading
  // `scrollHeight`, which would force a layout on every revision.
  // The thread opens in `follow`, so the very first pin anchors to the newest turn.
  const { mode, enterFollow } = useChatFollowScroll({
    scrollRef: viewportRef,
    contentHeight: virtualizer.getTotalSize(),
  });

  // Reacquire follow when the user submits (each local message bumps the revision).
  useEffect(() => {
    if (tailFollowRevision === 0) return;
    enterFollow();
  }, [tailFollowRevision, enterFollow]);

  const renderTurn = useCallback(
    (turn: Turn, idx: number) => {
      if (turn.role === "user") {
        return (
          <UserTurn
            turn={turn}
            submissionRecovery={submissionRecoveryByTurnId?.get(turn.id)}
            queueStatus={queueStatusByTurnId?.get(turn.id)}
          />
        );
      }
      return (
        <AssistantTurn
          threadId={threadId}
          turn={turn}
          deliveryEvents={deliveryEventsAfter(turn, turns)}
          isLatestAssistant={idx === lastAssistantIdx}
          onRetry={turn.id === failedSendRetry?.turnId ? failedSendRetry.retry : undefined}
          onRespondToInterrupt={onRespondToInterrupt}
          changeTrail={byTurnId.get(turn.id)}
          navigateToChange={navigateToChange}
        />
      );
    },
    [
      byTurnId,
      failedSendRetry,
      lastAssistantIdx,
      navigateToChange,
      onRespondToInterrupt,
      submissionRecoveryByTurnId,
      queueStatusByTurnId,
      threadId,
      turns,
    ],
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
            aria-label="Chat turns"
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
        onClick={enterFollow}
      />
    </div>
  );
}

function deliveryEventsAfter(
  turn: Turn,
  turns: Turn[],
): Array<{ turn: Turn; childThreadId?: string; title?: string }> {
  const events: Array<{ turn: Turn; childThreadId?: string; title?: string }> = [];
  let precedingId = turn.id;
  for (;;) {
    const next = turns.find((candidate) => candidate.prevTurnId === precedingId);
    if (!next) return events;
    if (!isDeliveryEvent(next)) {
      if (!isHiddenContextTurn(next)) return events;
      precedingId = next.id;
      continue;
    }
    const metadata = next.metadata as Record<string, unknown>;
    const invocation =
      metadata.kind === "subagent_update"
        ? findInvocation(turns, String(metadata.execution))
        : null;
    events.push({
      turn: next,
      ...(invocation?.threadId ? { childThreadId: invocation.threadId } : {}),
      ...(invocation?.title ? { title: invocation.title } : {}),
    });
    precedingId = next.id;
  }
}

function isHiddenContextTurn(turn: Turn): boolean {
  if (turn.role === "system") return !turn.blocks.some((block) => block.blockType === "custom");
  const metadata = turn.metadata;
  return Boolean(
    turn.role === "user" &&
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      metadata.kind === "system_update" &&
      metadata.section === "work_context",
  );
}

function isDeliveryEvent(turn: Turn): boolean {
  const metadata = turn.metadata;
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata.kind === "inbox_message" || metadata.kind === "subagent_update"),
  );
}

function findInvocation(
  turns: Turn[],
  execution: string,
): { threadId?: string; title?: string } | null {
  for (const turn of turns)
    for (const block of turn.blocks) {
      const content = block.content;
      if (
        !content ||
        typeof content !== "object" ||
        Array.isArray(content) ||
        content.kind !== "helper-result"
      )
        continue;
      const props = content.props;
      if (
        !props ||
        typeof props !== "object" ||
        Array.isArray(props) ||
        props.execution !== execution
      )
        continue;
      return {
        threadId: typeof props.childThreadId === "string" ? props.childThreadId : undefined,
        title: typeof props.title === "string" ? props.title : undefined,
      };
    }
  return null;
}

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
      // `inert` makes the faded-out pill genuinely gone — unclickable, unfocusable,
      // and out of the accessibility tree — while CSS keeps animating the exit.
      // Without it the invisible button would still be an enabled hit target.
      inert={hidden}
      style={{ bottom: bottomInset + 12 }}
    >
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        onClick={onClick}
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
