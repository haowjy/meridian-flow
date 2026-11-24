import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ChatReferenceScope } from "@meridian/thread-client";
import { CircleStop } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { FailureCard } from "@/components/app/FailureCard";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { chatCardText } from "../chat-card-copy";
import { useSubagentStop } from "./useSubagentStop";

type StopScope = { accountId: string; scope: ChatReferenceScope | null };

const StopScopeContext = createContext<StopScope | null>(null);

export const SubagentStopScope = StopScopeContext.Provider;

export function useSubagentStopScope(): StopScope | null {
  return useContext(StopScopeContext);
}

export function SubagentStop({
  threadId,
  name,
  stopScope,
  children,
}: {
  threadId: string;
  name: string;
  stopScope: StopScope;
  children: (controls: { button: ReactNode; failures: ReactNode }) => ReactNode;
}) {
  const { status, cards, stop, act } = useSubagentStop({ threadId, ...stopScope });
  const stopping = status === "pending" || status === "stopping";
  const button =
    cards.length === 0 ? (
      <IconButton
        type="button"
        size="sm"
        label={stopping ? t`Stopping "${name}"` : t`Stop "${name}"`}
        aria-disabled={stopping || undefined}
        data-subagent-stop={status}
        onClick={(event) => {
          event.stopPropagation();
          stop();
        }}
        className="relative size-7"
      >
        <CircleStop aria-hidden />
        {stopping ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0.5 rounded-full border-2 border-current/25 border-t-current motion-safe:animate-spin"
          />
        ) : null}
      </IconButton>
    ) : null;
  const failures = cards.map((card) => (
    <FailureCard
      key={card.key}
      tone="error"
      inline
      onDismiss={card.action === "dismiss" ? () => act(card) : undefined}
    >
      <p data-chat-card={card.copy} data-failure-id={card.key}>
        {chatCardText(card)}
      </p>
      {card.action === "try_again" ? (
        <Button type="button" variant="outline" size="xs" onClick={() => act(card)}>
          <Trans>Try again</Trans>
        </Button>
      ) : null}
    </FailureCard>
  ));
  return children({ button, failures: failures.length ? failures : null });
}
