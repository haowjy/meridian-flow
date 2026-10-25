/**
 * The chat's failure cards, drawn by anchor. `chatCards` (`@meridian/thread-client`) decides which
 * cards exist and where; this file draws each one as a `FailureCard` where it is anchored (a turn,
 * a queued command's row, a writer message, the composer's card stack) and decides nothing. A card's
 * button calls the handler its copy names; the words come from `chatCardText`, and one announcer
 * (`useChatCardAnnouncer`) speaks each card once.
 */
import { t } from "@lingui/core/macro";
import type { ChatCard, ChatCardAnchor } from "@meridian/thread-client";
import { createContext, memo, type ReactNode, useContext } from "react";
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

const ChatCardsContext = createContext<readonly ChatCard[]>([]);
const ChatCardHandlersContext = createContext<ChatCardHandlers | null>(null);

export function ChatCardsProvider({
  cards,
  handlers,
  children,
}: {
  cards: readonly ChatCard[];
  handlers: ChatCardHandlers;
  children: ReactNode;
}) {
  return (
    <ChatCardsContext.Provider value={cards}>
      <ChatCardHandlersContext.Provider value={handlers}>
        {children}
      </ChatCardHandlersContext.Provider>
    </ChatCardsContext.Provider>
  );
}

type AnchoredCardViewProps = {
  cards: readonly ChatCard[];
  recovery: UserTurnRecovery | null;
  wrapClassName?: string;
};

export function sameChatCardAnchor(a: ChatCardAnchor, b: ChatCardAnchor): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if ("turn" in a) return "turn" in b && a.turn === b.turn;
  if ("message" in a) return "message" in b && a.message === b.message;
  return "queuedControl" in b && a.queuedControl === b.queuedControl;
}

export function sameChatCards(left: readonly ChatCard[], right: readonly ChatCard[]): boolean {
  const fields = {
    key: "value",
    failure: "failure",
    copy: "value",
    action: "value",
    anchor: "anchor",
    count: "value",
    text: "value",
    requestId: "value",
  } satisfies Record<keyof ChatCard, "value" | "failure" | "anchor">;
  return (
    left.length === right.length &&
    left.every((card, index) => {
      const other = right[index];
      if (!other) return false;
      return (Object.keys(fields) as (keyof ChatCard)[]).every((field) => {
        if (fields[field] === "anchor") return sameChatCardAnchor(card.anchor, other.anchor);
        if (fields[field] === "failure") return sameFailure(card.failure, other.failure);
        return card[field] === other[field];
      });
    })
  );
}

function sameFailure(left: ChatCard["failure"], right: ChatCard["failure"]): boolean {
  const fields = {
    category: "value",
    source: "value",
    actionable: "value",
    cause: "cause",
  } satisfies Record<keyof ChatCard["failure"], "value" | "cause">;
  const causeFields = {
    code: "value",
    reason: "value",
    status: "value",
  } satisfies Record<keyof ChatCard["failure"]["cause"], "value">;
  return (Object.keys(fields) as (keyof ChatCard["failure"])[]).every((field) => {
    if (fields[field] !== "cause") return left[field] === right[field];
    return (Object.keys(causeFields) as (keyof ChatCard["failure"]["cause"])[]).every(
      (causeField) => left.cause[causeField] === right.cause[causeField],
    );
  });
}

/** The cards anchored at one place, in `chatCards` order. */
export function useCardsAt(anchor: ChatCardAnchor): readonly ChatCard[] {
  return useContext(ChatCardsContext).filter((card) => sameChatCardAnchor(card.anchor, anchor));
}

/** Every card at an anchor. A message card's Retry and Edit are the writer row's own recovery. */
function AnchoredCardsReader({
  anchor,
  recovery,
  wrapClassName,
}: {
  anchor: ChatCardAnchor;
  recovery?: UserTurnRecovery | null;
  /** Wraps the cards in one box, drawn only when there are any. */
  wrapClassName?: string;
}) {
  const cards = useContext(ChatCardsContext).filter((card) =>
    sameChatCardAnchor(card.anchor, anchor),
  );
  return (
    <AnchoredCardViews cards={cards} recovery={recovery ?? null} wrapClassName={wrapClassName} />
  );
}

const AnchoredCardViews = memo(function AnchoredCardViews({
  cards,
  recovery,
  wrapClassName,
}: AnchoredCardViewProps) {
  if (cards.length === 0) return null;
  return <CardViewsWithHandlers cards={cards} recovery={recovery} wrapClassName={wrapClassName} />;
}, sameAnchoredCardViews);

function CardViewsWithHandlers({ cards, recovery, wrapClassName }: AnchoredCardViewProps) {
  const handlers = useContext(ChatCardHandlersContext);
  if (!handlers) return null;
  const views = cards.map((card) => (
    <CardView key={card.key} card={card} handlers={handlers} recovery={recovery} />
  ));
  return wrapClassName ? <div className={wrapClassName}>{views}</div> : views;
}

function sameAnchoredCardViews(
  previous: AnchoredCardViewProps,
  next: AnchoredCardViewProps,
): boolean {
  return (
    previous.recovery === next.recovery &&
    previous.wrapClassName === next.wrapClassName &&
    sameChatCards(previous.cards, next.cards)
  );
}

export const AnchoredCards = memo(AnchoredCardsReader, (previous, next) => {
  return (
    sameChatCardAnchor(previous.anchor, next.anchor) &&
    previous.recovery === next.recovery &&
    previous.wrapClassName === next.wrapClassName
  );
});
AnchoredCards.displayName = "AnchoredCards";

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
    <FailureCard
      tone="error"
      announce={false}
      inline={inline}
      onDismiss={dismiss}
      note={
        card.copy === "updates-disconnected" ? (
          <p>{t`Reload to see the latest replies.`}</p>
        ) : undefined
      }
    >
      <p
        className={inline ? undefined : "min-w-0 flex-1"}
        data-chat-card={card.copy}
        data-failure-id={card.key}
      >
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
    case "reload":
      return button(t`Reload`, () => window.location.reload());
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
