/**
 * The cards a hand-back or Send now still owes the writer, in the composer's notice stack above
 * the box. `handBackCards` (`@meridian/thread-client`) decides which show, with which copy and
 * action; this file draws them. They sit here, not on the queued rows, because a hand-back that
 * committed has already removed its rows. They announce through the hooks, not themselves.
 */
import { plural, t } from "@lingui/core/macro";
import type { HandBackCard } from "@meridian/thread-client";
import { NoticeCard } from "@/components/app/NoticeCard";
import { Button } from "@/components/ui/button";

function cardCopy(card: HandBackCard): string {
  switch (card.copy) {
    case "stop-failed":
      return t`Couldn't stop the reply.`;
    case "send-now-failed":
      return t`Couldn't send now.`;
    case "hand-back-refused":
      return plural(card.count, {
        one: "Couldn't move your queued message.",
        other: "Couldn't move your queued messages.",
      });
    case "hand-back-failed":
      return plural(card.count, {
        one: "Couldn't move your queued message to the message box.",
        other: "Couldn't move your queued messages to the message box.",
      });
  }
}

export function HandBackCards({
  cards,
  onRetry,
  onDismiss,
}: {
  cards: readonly HandBackCard[];
  onRetry: (card: HandBackCard) => void;
  onDismiss: (card: HandBackCard) => void;
}) {
  return (
    <>
      {cards.map((card) => (
        <NoticeCard
          key={card.key}
          tone="error"
          announce={false}
          onDismiss={card.action === "dismiss" ? () => onDismiss(card) : undefined}
        >
          <p className="min-w-0 flex-1" data-hand-back-card={card.copy}>
            {cardCopy(card)}
          </p>
          {card.action === "retry" ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-hand-back-card-retry
              onClick={() => onRetry(card)}
            >
              {t`Try again`}
            </Button>
          ) : null}
        </NoticeCard>
      ))}
    </>
  );
}
