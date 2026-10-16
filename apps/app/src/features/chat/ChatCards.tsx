/**
 * The chat's failure cards, drawn by anchor. `chatCards` (`@meridian/thread-client`) decides which
 * cards exist and where; this file draws each one as a `FailureCard` where it is anchored (a turn,
 * a queued command's row, a writer message, the composer's card stack) and decides nothing. A card's
 * button calls the handler its copy names; the words come from `chatCardText`, and one announcer
 * (`useChatCardAnnouncer`) speaks each card once.
 */
import { t } from "@lingui/core/macro";
import type { ChatCard, ChatCardAnchor } from "@meridian/thread-client";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { UserTurnRecovery } from "@/client/chat-submissions/presentation";
import { FailureCard } from "@/components/app/FailureCard";
import { Button } from "@/components/ui/button";
import { chatCardText } from "./chat-card-copy";

/** What each card's action does; the hooks behind them own the commands. */
export type ChatCardHandlers = {
  /** A failed reply's Retry. */
  retryReply: (turnId: string) => void;
  /** A failed manual compaction's Try again: send `/compact` again with its instructions. */
  tryAgainCompaction: (turnId: string) => void;
  /** A lost Retry's Try again: the same request again. */
  retryLost: (turnId: string) => void;
  /** A handoff brief's failed Stop, again. */
  retryBriefStop: (turnId: string) => void;
  /** A hand-back or Stop request the card holds. */
  handBack: { retry: (requestId: string) => void; dismiss: (requestId: string) => void };
  sendNow: { retry: () => void; dismiss: () => void };
  /** A queued command's failed enqueue (Retry) or failed withdraw (Try again). */
  control: { retry: (controlId: string) => void; stop: (controlId: string) => void };
  addUsage: () => void;
};

type ChatCardsContextValue = { cards: readonly ChatCard[]; handlers: ChatCardHandlers };

const ChatCardsContext = createContext<ChatCardsContextValue | null>(null);

export function ChatCardsProvider({
  cards,
  handlers,
  children,
}: ChatCardsContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ cards, handlers }), [cards, handlers]);
  return <ChatCardsContext.Provider value={value}>{children}</ChatCardsContext.Provider>;
}

const NONE: readonly ChatCard[] = [];

function sameAnchor(a: ChatCardAnchor, b: ChatCardAnchor): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if ("turn" in a) return "turn" in b && a.turn === b.turn;
  if ("message" in a) return "message" in b && a.message === b.message;
  return "queuedControl" in b && a.queuedControl === b.queuedControl;
}

/** The cards anchored at one place, in `chatCards` order. */
export function useCardsAt(anchor: ChatCardAnchor): readonly ChatCard[] {
  const context = useContext(ChatCardsContext);
  return context?.cards.filter((card) => sameAnchor(card.anchor, anchor)) ?? NONE;
}

/** Every card at an anchor. A message card's Retry and Edit are the writer row's own recovery. */
export function AnchoredCards({
  anchor,
  recovery,
  wrapClassName,
}: {
  anchor: ChatCardAnchor;
  recovery?: UserTurnRecovery | null;
  /** Wraps the cards in one box, drawn only when there are any. */
  wrapClassName?: string;
}) {
  const cards = useCardsAt(anchor);
  const handlers = useContext(ChatCardsContext)?.handlers;
  if (!handlers || cards.length === 0) return null;
  const views = cards.map((card) => (
    <CardView key={card.key} card={card} handlers={handlers} recovery={recovery ?? null} />
  ));
  return wrapClassName ? <div className={wrapClassName}>{views}</div> : views;
}

function CardView({
  card,
  handlers,
  recovery,
}: {
  card: ChatCard;
  handlers: ChatCardHandlers;
  recovery: UserTurnRecovery | null;
}) {
  const inline = typeof card.anchor !== "string" && !("turn" in card.anchor);
  const dismiss = card.action === "dismiss" ? dismissOf(card, handlers) : undefined;
  return (
    <FailureCard tone="error" announce={false} inline={inline} onDismiss={dismiss}>
      <p className={inline ? undefined : "min-w-0 flex-1"} data-chat-card={card.copy}>
        {chatCardText(card)}
      </p>
      <CardAction card={card} handlers={handlers} recovery={recovery} />
    </FailureCard>
  );
}

function dismissOf(card: ChatCard, handlers: ChatCardHandlers): (() => void) | undefined {
  if (card.copy === "send-now-failed") return handlers.sendNow.dismiss;
  const requestId = card.requestId;
  return requestId ? () => handlers.handBack.dismiss(requestId) : undefined;
}

function CardAction({
  card,
  handlers,
  recovery,
}: {
  card: ChatCard;
  handlers: ChatCardHandlers;
  recovery: UserTurnRecovery | null;
}) {
  const { anchor } = card;
  const button = (label: string, onClick: () => void, disabled?: boolean) => (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-chat-card-action={card.action}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  switch (card.action) {
    case "add_usage":
      return button(t`Add usage`, handlers.addUsage);
    case "retry":
      if (typeof anchor !== "string" && "turn" in anchor) {
        const turnId = anchor.turn;
        return button(t`Retry`, () => handlers.retryReply(turnId));
      }
      if (typeof anchor !== "string" && "queuedControl" in anchor) {
        const controlId = anchor.queuedControl;
        return button(t`Retry`, () => handlers.control.retry(controlId));
      }
      return null;
    case "try_again":
      return tryAgain(card, handlers, button);
    case "edit_or_send":
      return (
        <>
          {recovery?.onRetry ? button(t`Retry`, recovery.onRetry) : null}
          {recovery?.onEdit ? button(t`Edit`, recovery.onEdit, recovery.busy) : null}
        </>
      );
    default:
      return null;
  }
}

function tryAgain(
  card: ChatCard,
  handlers: ChatCardHandlers,
  button: (label: string, onClick: () => void) => ReactNode,
): ReactNode {
  const label = t`Try again`;
  const { anchor } = card;
  if (typeof anchor !== "string" && "queuedControl" in anchor) {
    const controlId = anchor.queuedControl;
    return button(label, () => handlers.control.stop(controlId));
  }
  if (typeof anchor !== "string" && "turn" in anchor) {
    const turnId = anchor.turn;
    if (card.copy === "compaction-failed")
      return button(label, () => handlers.tryAgainCompaction(turnId));
    if (card.copy === "brief-stop-failed")
      return button(label, () => handlers.retryBriefStop(turnId));
    return button(label, () => handlers.retryLost(turnId));
  }
  if (card.copy === "send-now-failed") return button(label, handlers.sendNow.retry);
  const requestId = card.requestId;
  return requestId ? button(label, () => handlers.handBack.retry(requestId)) : null;
}
