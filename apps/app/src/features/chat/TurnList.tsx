/**
 * TurnList — single Virtuoso list keyed by `turn.id` that renders BOTH live
 * and settled assistant turns through the same row position.
 *
 * After Stream S3 convergence, the live assistant turn is merged into the
 * `turns` array by id (see `useChatThreadSession`). When the turn settles,
 * the same `turn.id` row stays mounted and only its `Turn` data changes — no
 * remount, no flicker, expand/collapse and scroll position survive.
 *
 * Draft anchoring: `draftsByTurnId` (computed by ChatView from
 * `useThreadDrafts`) hands per-turn `ThreadDraftGroup[]` arrays to assistant
 * turns so the DraftReviewCard renders inside the producing turn's row.
 * Keeping the lookup in the parent keeps Virtuoso item identity stable.
 *
 * Cards inside a virtualized row CANNOT own a fixed-position modal — when
 * Virtuoso recycles the row the modal vanishes with it. The card calls the
 * shared draft-review controller; the overlay lives at the (non-virtualized)
 * ChatView root.
 */
import type { Turn } from "@meridian/contracts/protocol";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  forwardRef,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { type Components, Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";

import { AssistantTurn } from "./AssistantTurn";
import type { InterruptRespondRequest } from "./CustomBlockRenderer";
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
  /** ChatSurface's scroll element; Virtuoso must not create a second scroller. */
  scrollParent: HTMLElement | null;
  /** Monotonic submit signal: new local messages intentionally reacquire tail-follow. */
  tailFollowRevision: number;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  /** Active AI draft groups keyed by the assistant turn that produced them. */
  draftsByTurnId?: Map<string, ThreadDraftGroup[]>;
  /** Shared draft review state machine owned by ChatView. */
  draftReviewController?: DraftReviewController;
};

/**
 * Renders the conversation column: settled + live turns through one Virtuoso
 * data list keyed by `turn.id`.
 */
export function TurnList({
  threadId,
  turns,
  scrollParent,
  tailFollowRevision,
  onRespondToInterrupt,
  draftsByTurnId,
  draftReviewController,
}: TurnListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  const visibleTurns = useMemo(() => filterVisibleTurns(turns), [turns]);
  const lastAssistantIdx = findLastAssistantIndex(visibleTurns);
  // Whether the current tail is a live assistant turn whose internal block
  // mutations should keep the list pinned to the bottom while we autoscroll.
  const tailTurn = visibleTurns[visibleTurns.length - 1];
  const isTailLive =
    tailTurn?.role === "assistant" &&
    (tailTurn.status === "streaming" || tailTurn.status === "pending");
  const initialTopMostItemIndex =
    visibleTurns.length > 0
      ? ({ index: visibleTurns.length - 1, align: "end" } as const)
      : undefined;

  const followOutput = useCallback((isAtBottom: boolean) => {
    atBottomRef.current = isAtBottom;
    return isAtBottom ? "smooth" : false;
  }, []);

  const itemContent = useCallback(
    (idx: number, turn: Turn) => {
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
          onRespondToInterrupt={onRespondToInterrupt}
          draftGroups={draftGroups}
          draftReviewController={rowDraftReviewController}
        />
      );
    },
    [draftReviewController, draftsByTurnId, lastAssistantIdx, onRespondToInterrupt, threadId],
  );

  const components = useMemo<Components<Turn>>(
    () => ({
      List: ConversationList,
      Item: ConversationItem,
    }),
    [],
  );

  useEffect(() => {
    if (tailFollowRevision === 0 || visibleTurns.length === 0) return;
    atBottomRef.current = true;
    virtuosoRef.current?.scrollToIndex({
      index: visibleTurns.length - 1,
      align: "end",
      behavior: "smooth",
    });
  }, [tailFollowRevision, visibleTurns.length]);

  // While the tail turn is live, content height grows as deltas arrive. Stay
  // pinned to the bottom whenever the user has not scrolled away. Use the
  // turn's identity AND its block count so Virtuoso autoscrolls on every
  // streamed block change.
  const tailBlockCount = tailTurn?.blocks.length ?? 0;
  useEffect(() => {
    if (!isTailLive) return;
    if (!atBottomRef.current) return;
    virtuosoRef.current?.autoscrollToBottom();
  }, [isTailLive, tailBlockCount, tailTurn?.id]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      aria-label="Conversation turns"
      alignToBottom
      atBottomStateChange={(atBottom) => {
        atBottomRef.current = atBottom;
      }}
      atBottomThreshold={300}
      components={components}
      computeItemKey={(_idx, turn) => turn.id}
      customScrollParent={scrollParent ?? undefined}
      data={visibleTurns}
      data-chat-virtual-list
      data-settled-turn-count={visibleTurns.length}
      followOutput={followOutput}
      initialTopMostItemIndex={initialTopMostItemIndex}
      itemContent={itemContent}
      style={virtuosoStyle}
    />
  );
}

const virtuosoStyle: CSSProperties = {
  height: "100%",
  overflowAnchor: "none",
};

const ConversationList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function ConversationList(props, ref) {
    return (
      <ol
        {...(props as ComponentPropsWithoutRef<"ol">)}
        ref={ref as unknown as Ref<HTMLOListElement>}
        className="flex list-none flex-col"
        aria-label="Conversation turns"
      />
    );
  },
);

type VirtuosoItemProps = ComponentPropsWithoutRef<"div"> & { item?: unknown };

const ConversationItem = forwardRef<HTMLDivElement, VirtuosoItemProps>(
  function ConversationItem(props, ref) {
    const { item: _item, ...domProps } = props;
    return (
      <li
        {...(domProps as ComponentPropsWithoutRef<"li">)}
        ref={ref as unknown as Ref<HTMLLIElement>}
        data-chat-turn-row="settled"
      />
    );
  },
);

/** Index of the last assistant turn in `turns`, or -1 if none. */
function findLastAssistantIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return i;
  }
  return -1;
}
