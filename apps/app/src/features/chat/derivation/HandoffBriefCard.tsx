/**
 * The handoff brief card: the first thing in a handed-off chat, and the card
 * each Retry adds at the leaf.
 *
 * A pending seed is a brief being written. While it is, the card says so and
 * offers Stop (the composer's Stop targets the same turn). A ready brief shows
 * the summary the new Agent starts from, clipped with Show more. A brief that
 * failed, was stopped, or was cut off by a restart says so, and the newest one
 * offers Retry, which adds a new card at once. Its failures (the brief's own, a failed Stop, a refused
 * or lost Retry) are `FailureCard`s from `chatCards`, drawn here by the brief's turn. Retry waits while the chat is
 * busy (a reply or a compaction): the server refuses a brief then. The
 * source's name links back to it. State changes are spoken by the global
 * announcer, never a live region here.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { readHandoffSeed } from "@meridian/contracts/threads";
import { Forward } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/rich-content/Markdown";
import { AnchoredCards, useCardsAt } from "../ChatCards";
import { ClippedProse } from "../ClippedExpand";
import { useFocusWithinRow } from "../compaction/useFocusWithinRow";
import { type BriefCardView, briefCardView } from "./handoff-seed";
import { SourceChatLink, useSourceThread } from "./SourceChatLink";

export type HandoffBriefCardProps = {
  turn: Turn;
  /** The newest seed: only it can be retried. */
  latest: boolean;
  stopping: boolean;
  /** A reply (or anything else) holds the chat: Retry waits until it ends. */
  destinationBusy?: boolean;
  /** Absent in a read-only view (a fork's inherited brief) or before the server has the seed. */
  onStop?: (turnId: string) => void;
  /** Absent in a read-only view. */
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
  // The title frozen on S stands in until the current one is known, and names a trashed source.
  const source = useSourceThread(seed?.sourceThreadId ?? "", seed?.sourceTitle ?? null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithin = useFocusWithinRow(sectionRef);
  // The Stop flag outlives the seed: a stopped or finished brief says what it is.
  const title =
    stopping && view.state === "generating" ? t`Stopping the handoff brief` : stateTitle(view);
  const failures = useCardsAt({ turn: turn.id });
  const canRetry =
    view.state === "stopped"
      ? view.canRetry
      : failures.some((card) => card.copy === "brief-failed");
  // For a source that was untitled when S was created: refs are never writer copy.
  const sourceFallbackName = t`the source chat`;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      {...focusWithin}
      aria-label={title}
      data-handoff-brief
      data-handoff-brief-state={view.state}
      className="surface-card chat-card [--chat-card-radius:var(--radius-xl)] [--chat-card-border:var(--color-border-subtle)] shadow-xs outline-none"
    >
      <div className="flex items-start gap-[var(--chat-space-inline)]">
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
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
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
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
              {/* One message, so a translation can put the source's name first. */}
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
            <p className="text-caption text-muted-foreground">
              <Trans>This chat continues without a brief.</Trans>
            </p>
          ) : null}
          {canRetry && onRetry && destinationBusy ? (
            <p id={retryWaitId} className="text-caption text-muted-foreground">
              <Trans>You can retry when this chat is free.</Trans>
            </p>
          ) : null}
          {view.brief ? <BriefText brief={view.brief} /> : null}
        </div>
      </div>
    </section>
  );
}

/** The brief, clipped to the card's height until the writer asks for all of it. */
function BriefText({ brief }: { brief: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const toggle = (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      aria-expanded={expanded}
      aria-controls={bodyId}
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? <Trans>Show less</Trans> : <Trans>Show the whole brief</Trans>}
    </Button>
  );
  return (
    <div id={bodyId} className="mt-[var(--chat-space-inline)]" data-handoff-brief-text>
      {expanded ? (
        <>
          <Markdown variant="compact">{brief}</Markdown>
          <div className="mt-[var(--chat-space-inline)]">{toggle}</div>
        </>
      ) : (
        <ClippedProse footer={toggle}>
          <Markdown variant="compact">{brief}</Markdown>
        </ClippedProse>
      )}
    </div>
  );
}
