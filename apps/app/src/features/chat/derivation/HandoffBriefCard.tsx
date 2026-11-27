import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { readHandoffSeed } from "@meridian/contracts/threads";
import { Forward } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/rich-content/Markdown";
import { AnchoredCards, useCardsAt } from "../ChatCards";
import { ExpandableProse } from "../ClippedExpand";
import { useFocusWithinRow } from "../compaction/useFocusWithinRow";
import { type BriefCardView, briefCardView } from "./handoff-seed";
import { SourceChatLink, useSourceThread } from "./SourceChatLink";

export type HandoffBriefCardProps = {
  turn: Turn;
  latest: boolean;
  stopping: boolean;
  destinationBusy?: boolean;
  onStop?: (turnId: string) => void;
  onRetry?: (turn: Turn) => void;
};

function stateTitle(view: BriefCardView) {
  switch (view.state) {
    case "generating":
      return t`Writing the handoff brief`;
    case "ready":
    case "failed":
      return t`Handoff brief`;
    case "stopped":
      return t`Handoff brief stopped`;
  }
}

export function HandoffBriefCard({
  turn,
  latest,
  stopping,
  destinationBusy = false,
  onStop,
  onRetry,
}: HandoffBriefCardProps) {
  const seed = readHandoffSeed(turn);
  const view = briefCardView({ turn, latest, stopping });
  const retryWaitId = useId();
  const source = useSourceThread(seed?.sourceThreadId ?? "", seed?.sourceTitle ?? null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithin = useFocusWithinRow(sectionRef);
  const title =
    stopping && view.state === "generating" ? t`Stopping the handoff brief` : stateTitle(view);
  const failures = useCardsAt({ turn: turn.id });
  const canRetry =
    view.state === "stopped"
      ? view.canRetry
      : failures.some((card) => card.action === "retry_brief");
  const sourceFallbackName = t`the source chat`;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      {...focusWithin}
      aria-label={title}
      data-handoff-brief
      data-handoff-brief-state={view.state}
      className="surface-card chat-card [--chat-card-radius:var(--radius-xl)] [--chat-card-border:var(--color-border-subtle)] shadow-raise outline-none"
    >
      <div className="flex items-start gap-[var(--chat-space-inline)]">
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink-fill text-muted-foreground">
          <Forward className="size-3.5" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[var(--chat-space-inline)]">
          <div className="flex min-w-0 flex-wrap items-center gap-x-[var(--chat-space-block)]">
            {view.state === "generating" ? <span aria-hidden className="streaming-dot" /> : null}
            <p className="min-w-0 text-sm font-medium text-foreground">{title}</p>
            {view.state === "generating" && onStop ? (
              <Button
                type="button"
                variant="quiet"
                size="meta"
                // aria-disabled, not disabled: disabling the focused button would
                // drop keyboard focus to the page.
                aria-disabled={!view.canStop || undefined}
                aria-label={t`Stop the handoff brief`}
                data-focus-landing
                onClick={() => {
                  if (view.canStop) onStop(turn.id);
                }}
              >
                <Trans>Stop</Trans>
              </Button>
            ) : null}
            {canRetry && onRetry ? (
              <Button
                type="button"
                variant="quiet"
                size="meta"
                aria-label={t`Retry the handoff brief`}
                // aria-disabled, not disabled: Stop gives way to Retry and
                // keyboard focus follows it there even while the chat is busy,
                // where the wait note it is described by is read with it.
                aria-disabled={destinationBusy || undefined}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:text-muted-foreground"
                aria-describedby={destinationBusy ? retryWaitId : undefined}
                data-focus-landing
                onClick={() => {
                  if (!destinationBusy) onRetry(turn);
                }}
              >
                <Trans>Retry</Trans>
              </Button>
            ) : null}
          </div>
          {seed ? (
            <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
              <Trans>
                <span className="shrink-0">Handed off from </span>
                <SourceChatLink
                  threadId={seed.sourceThreadId}
                  title={source.title}
                  trashed={source.trashed}
                  fallbackName={sourceFallbackName}
                />
              </Trans>
            </p>
          ) : null}
          <AnchoredCards anchor={{ turn: turn.id }} />
          {view.state === "stopped" && !view.superseded ? (
            <p className="text-xs text-muted-foreground">
              <Trans>This chat continues without a brief.</Trans>
            </p>
          ) : null}
          {canRetry && onRetry && destinationBusy ? (
            <p id={retryWaitId} className="text-xs text-muted-foreground">
              <Trans>You can retry when this chat is free.</Trans>
            </p>
          ) : null}
          {view.brief ? <BriefText brief={view.brief} /> : null}
        </div>
      </div>
    </section>
  );
}

function BriefText({ brief }: { brief: string }) {
  return (
    <div className="mt-[var(--chat-space-inline)]" data-handoff-brief-text>
      <ExpandableProse more={<Trans>Show the whole brief</Trans>}>
        <Markdown variant="compact">{brief}</Markdown>
      </ExpandableProse>
    </div>
  );
}
