/**
 * The compaction divider: where the model's working context was summarized.
 *
 * One quiet rule across the transcript, with the state in words at its start
 * and its controls right after the words (bare transcript rows never
 * right-align controls). A compaction is a turn: once it finishes, its action
 * is Fork (no Copy, no Hand off), revealed like a reply's actions. The summary
 * sits behind a disclosure; a running compaction's Stop lives on the same
 * line. The writer's `/compact <instructions>` sit under the line, verbatim. A
 * manual compaction's failure speaks on the divider it belongs to. An
 * autocompaction's failure stays quiet (R3): the failed reply under the
 * writer's newest message already says so. State changes are spoken by the
 * global polite announcer, never a live region on the row.
 */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { ThreadPhase } from "@meridian/contracts/threads";
import { ChevronRight, CircleAlert, FoldVertical } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { ForkTurnAction } from "../derivation/DeriveTurnActions";
import { CompactionInstructions } from "./CompactionInstructions";
import { type DividerView, dividerView } from "./compaction-model";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type CompactionDividerProps = {
  turn: Turn;
  /** The thread's live lease phase, when it is awake. */
  phase: ThreadPhase | null;
  stopping: boolean;
  onStop?: (turnId: string) => void;
};

type StateLabel = {
  /** The divider's state in words; also the section's accessible name. */
  full: string;
  /** What a narrow chat column shows, so the divider stays on one line. */
  short: string;
};

function stateLabel(view: DividerView, phase: ThreadPhase | null, stopping: boolean): StateLabel {
  const same = (label: string) => ({ full: label, short: label });
  switch (view.state) {
    case "pending":
      if (stopping) return { full: t`Stopping compaction`, short: t`Stopping` };
      return phase === "compacting" || phase === null
        ? { full: t`Compacting conversation`, short: t`Compacting` }
        : same(t`Waiting to compact`);
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

export function CompactionDivider({ turn, phase, stopping, onStop }: CompactionDividerProps) {
  const view = dividerView(turn);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithin = useFocusWithinRow(sectionRef);
  const label = stateLabel(view, phase, stopping);
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
        <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
          <DividerMark state={view.state} loud={loud} />
          <span
            className={cn(
              "min-w-0 truncate text-caption font-medium",
              view.state === "failed" && !loud ? "text-ink-subtle" : "text-ink-muted",
            )}
          >
            <span className="hidden @lg/divider:inline">{label.full}</span>
            <span className="@lg/divider:hidden">{label.short}</span>
          </span>
        </span>

        {view.summary ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={panelId}
          >
            <ChevronRight
              aria-hidden
              className={cn("transition-transform duration-200", open && "rotate-90")}
            />
            <Trans>Summary</Trans>
          </Button>
        ) : null}

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
          {view.tokens ? (
            <p className="mb-[var(--chat-space-block)] text-caption text-muted-foreground">
              {t`The model's context went from ${formatTokens(view.tokens.before)} to ${formatTokens(view.tokens.after)} tokens.`}
            </p>
          ) : null}
          <Markdown variant="compact">{view.summary}</Markdown>
        </div>
      ) : null}
    </section>
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
