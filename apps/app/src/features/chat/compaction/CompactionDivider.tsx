/**
 * The compaction divider: where the model's working context was summarized.
 *
 * One quiet rule across the transcript, with the state in words at its start
 * and its controls right after the words (bare transcript rows never
 * right-align controls). A compaction is a turn: once it finishes, its actions
 * are Fork and, for stats for nerds, Info (no Copy, no Hand off), revealed like
 * a reply's actions. A finished
 * divider's state words (icon and label, one button) open and close its
 * summary; a running compaction's Stop lives on the same line. The writer's `/compact <instructions>` sit under the line, verbatim. A
 * manual compaction's failure speaks on the divider it belongs to. An
 * autocompaction's failure stays quiet (R3): the failed reply under the
 * writer's newest message already says so. State changes are spoken by the
 * global polite announcer, never a live region on the row.
 */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import { CircleAlert, FoldVertical } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useStatsForNerds } from "@/hooks/use-stats-for-nerds";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { ForkTurnAction } from "../derivation/DeriveTurnActions";
import { TurnInfoButton, TurnInfoRow } from "../TurnInfoButton";
import { CompactionInstructions } from "./CompactionInstructions";
import { type DividerView, dividerView } from "./compaction-model";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type CompactionDividerProps = {
  turn: Turn;
  stopping: boolean;
  onStop?: (turnId: string) => void;
};

type StateLabel = {
  /** The divider's state in words; also the section's accessible name. */
  full: string;
  /** What a narrow chat column shows, so the divider stays on one line. */
  short: string;
};

function stateLabel(view: DividerView, stopping: boolean): StateLabel {
  const same = (label: string) => ({ full: label, short: label });
  switch (view.state) {
    case "pending":
      // A waiting `/compact` is a queued row, so a pending divider is compacting.
      if (stopping) return { full: t`Stopping compaction`, short: t`Stopping` };
      return { full: t`Compacting conversation`, short: t`Compacting` };
    case "complete":
      // Narrow, the trigger yields to the controls; the section's name keeps it.
      return view.trigger === "manual"
        ? { full: t`Conversation compacted`, short: t`Compacted` }
        : { full: t`Conversation compacted automatically`, short: t`Compacted` };
    case "failed":
      return view.trigger === "manual"
        ? same(t`Couldn't compact`)
        : { full: t`Conversation not compacted`, short: t`Not compacted` };
    case "cancelled":
      return same(t`Compaction stopped`);
  }
}

export function CompactionDivider({ turn, stopping, onStop }: CompactionDividerProps) {
  const view = dividerView(turn);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithin = useFocusWithinRow(sectionRef);
  const label = stateLabel(view, stopping);
  const loud = view.state === "failed" && view.failureCopy !== null;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      {...focusWithin}
      data-compaction-divider
      data-compaction-state={view.state}
      data-compaction-trigger={view.trigger}
      aria-label={label.full}
      className="@container/divider flex flex-col gap-[var(--chat-space-inline)] py-[var(--chat-space-block)] outline-none"
    >
      {/* One line at every width: a narrow column shows the short label, and
          the label truncates before a control or the rule would wrap. */}
      <div className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
        {view.summary ? (
          // The state words are the summary's disclosure: icon and label are
          // one button, so the row carries no separate "Summary" control.
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={label.full}
            // Stop's replacement: focus lands here when a finished run removes it.
            data-focus-landing
            // Negative margin: the hover wash grows outward, so the icon keeps
            // the edge every other divider state and the instructions align to.
            className="focus-ring -mx-1 flex min-w-0 items-center gap-[var(--chat-space-block)] rounded-md px-1 py-1 text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-foreground aria-expanded:text-foreground"
          >
            <DividerMark state={view.state} loud={loud} />
            <DividerLabel label={label} className="text-inherit" />
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
            <DividerMark state={view.state} loud={loud} />
            <DividerLabel
              label={label}
              className={view.state === "failed" && !loud ? "text-ink-subtle" : "text-ink-muted"}
            />
          </span>
        )}

        {view.state === "pending" && onStop ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            // aria-disabled, not disabled: disabling the focused button would
            // drop keyboard focus to the page.
            aria-disabled={stopping || undefined}
            aria-label={t`Stop compaction`}
            onClick={() => {
              if (!stopping) onStop(turn.id);
            }}
          >
            <Trans>Stop</Trans>
          </Button>
        ) : null}

        {view.state === "complete" ? (
          <span
            data-compaction-actions
            className="compaction-divider-actions flex shrink-0 transition-opacity"
          >
            <ForkTurnAction turnId={turn.id} />
            <CompactionInfo view={view} />
          </span>
        ) : null}

        <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />
      </div>

      {view.instructions ? <CompactionInstructions instructions={view.instructions} /> : null}

      {view.failureCopy ? (
        <p className="text-caption text-destructive">{view.failureCopy}</p>
      ) : null}

      {view.summary ? (
        <div
          id={panelId}
          hidden={!open}
          data-compaction-summary
          className="chat-card mt-[var(--chat-space-inline)] bg-muted/40"
        >
          <Markdown variant="compact">{view.summary}</Markdown>
        </div>
      ) : null}
    </section>
  );
}

/** With Stats for nerds on: the divider's stats, in the same popover a reply's Turn information opens. */
function CompactionInfo({ view }: { view: DividerView }) {
  const statsForNerds = useStatsForNerds();
  const { model, tokens } = view;
  if (!statsForNerds || (!model && !tokens)) return null;
  return (
    <TurnInfoButton
      label={t`Compaction information`}
      sections={[
        {
          title: t`Compaction`,
          rows: (
            <>
              {model ? (
                <TurnInfoRow
                  label={t`Model`}
                  value={model}
                  valueClassName="max-w-36 truncate font-medium"
                  title={model}
                />
              ) : null}
              {tokens ? (
                <>
                  <TurnInfoRow label={t`Tokens before`} value={formatTokens(tokens.before)} mono />
                  <TurnInfoRow label={t`Tokens after`} value={formatTokens(tokens.after)} mono />
                </>
              ) : null}
            </>
          ),
        },
      ]}
    />
  );
}

/** Full words on a wide column, the short form narrow; truncates before the row wraps. */
function DividerLabel({ label, className }: { label: StateLabel; className: string }) {
  return (
    <span data-compaction-label className={cn("min-w-0 truncate text-meta font-medium", className)}>
      <span className="hidden @lg/divider:inline">{label.full}</span>
      <span className="@lg/divider:hidden">{label.short}</span>
    </span>
  );
}

function DividerMark({ state, loud }: { state: DividerView["state"]; loud: boolean }) {
  if (state === "pending") return <span aria-hidden className="streaming-dot mx-1" />;
  if (loud) return <CircleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  return <FoldVertical aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(i18n.locale || undefined).format(value);
}
