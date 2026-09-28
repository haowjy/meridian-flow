/**
 * The compaction divider: where the model's working context was summarized.
 *
 * One quiet rule across the transcript, with the state in words at its start
 * and its controls right after the words (bare transcript rows never
 * right-align controls). The summary sits behind a disclosure; Undo, a queued
 * undo with Withdraw, and a pending compaction's Stop live on the same line.
 * A refused undo and a manual compaction's failure speak on the divider they
 * belong to. An autocompaction's failure stays quiet (R3): the failed reply
 * under the writer's newest message already says so.
 */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Turn } from "@meridian/contracts/protocol";
import type { CompactionUndoAvailability, ThreadPhase } from "@meridian/contracts/threads";
import { ChevronRight, CircleAlert, FoldVertical, UnfoldVertical } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { type CompactionUndoMarkers, type DividerView, dividerView } from "./compaction-model";
import type { QueuedControl } from "./thread-controls";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type CompactionDividerProps = {
  turn: Turn;
  undo: CompactionUndoMarkers;
  undoAvailability: CompactionUndoAvailability;
  /** A queued (or just settled) undo control that targets this divider. */
  queuedUndo: QueuedControl | null;
  /** The thread's live lease phase, when it is awake. */
  phase: ThreadPhase | null;
  stopping: boolean;
  onStop?: (turnId: string) => void;
  onUndo?: (compactionTurnId: string) => void;
  onWithdraw?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
};

/**
 * Client-owned copy where the server's would mislead: `context_too_large` on a
 * compaction means the conversation's retained part does not fit, not that the
 * writer's message is too long.
 */
export function compactionFailureCopy(
  reason: string | null,
  serverCopy: string | null,
): string | null {
  if (reason === "context_too_large")
    return t`Even compacted, this conversation is too large for its model.`;
  return serverCopy ?? t`This conversation couldn't be compacted.`;
}

function stateLabel(view: DividerView, phase: ThreadPhase | null, stopping: boolean): string {
  switch (view.state) {
    case "pending":
      if (stopping) return t`Stopping compaction`;
      return phase === "compacting" || phase === null
        ? t`Compacting conversation`
        : t`Waiting to compact`;
    case "complete":
      return view.trigger === "manual"
        ? t`Conversation compacted`
        : t`Conversation compacted automatically`;
    case "failed":
      return view.trigger === "manual" ? t`Couldn't compact` : t`Conversation not compacted`;
    case "cancelled":
      return t`Compaction stopped`;
    case "undone":
      return t`Compaction undone`;
  }
}

export function CompactionDivider({
  turn,
  undo,
  undoAvailability,
  queuedUndo,
  phase,
  stopping,
  onStop,
  onUndo,
  onWithdraw,
  onRetry,
}: CompactionDividerProps) {
  const view = dividerView({
    turn,
    markers: undo,
    undoAvailability,
    queuedUndo,
    failureCopyFor: compactionFailureCopy,
  });
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const focusWithin = useFocusWithinRow(sectionRef);
  const label = stateLabel(view, phase, stopping);
  const loud = view.state === "failed" && view.failureCopy !== null;

  const notes: { key: string; text: string; tone: "muted" | "error" }[] = [];
  if (view.failureCopy) notes.push({ key: "failure", text: view.failureCopy, tone: "error" });
  if (view.state === "undone")
    notes.push({
      key: "undone",
      text: t`The full conversation is back in context.`,
      tone: "muted",
    });
  if (view.refusalCopy) notes.push({ key: "refusal", text: view.refusalCopy, tone: "error" });
  // A refusal already says more than the advice would.
  if (view.undo?.kind === "offer" && view.undo.advisory && !view.refusalCopy)
    notes.push({
      key: "advisory",
      text: t`The full conversation may be too long to restore.`,
      tone: "muted",
    });
  if (view.undoNote === "withdrawn")
    notes.push({ key: "withdrawn", text: t`Undo withdrawn.`, tone: "muted" });
  if (view.undo?.kind === "queued" && view.undo.control.status === "failed")
    notes.push({ key: "undo-failed", text: t`Couldn't queue the undo.`, tone: "error" });
  if (view.undo?.kind === "queued" && view.undo.control.status === "withdraw_failed")
    notes.push({ key: "withdraw-failed", text: t`Couldn't withdraw the undo.`, tone: "error" });

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      {...focusWithin}
      data-compaction-divider
      data-compaction-state={view.state}
      data-compaction-trigger={view.trigger}
      aria-label={label}
      className="flex flex-col gap-[var(--chat-space-inline)] py-[var(--chat-space-block)] outline-none"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)]">
        <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
          <DividerMark state={view.state} loud={loud} />
          <span
            className={cn(
              "text-caption font-medium",
              view.state === "failed" && !loud ? "text-ink-subtle" : "text-ink-muted",
            )}
          >
            {label}
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

        {view.undo?.kind === "offer" && onUndo ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            aria-label={t`Undo compaction`}
            onClick={() => onUndo(turn.id)}
          >
            <Trans>Undo</Trans>
          </Button>
        ) : null}

        {view.undo?.kind === "queued" ? (
          <QueuedUndoControls
            control={view.undo.control}
            onWithdraw={onWithdraw}
            onRetry={onRetry}
          />
        ) : null}

        <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      </div>

      {notes.map((note) => (
        <p
          key={note.key}
          className={cn(
            "text-caption",
            note.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {note.text}
        </p>
      ))}

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

function QueuedUndoControls({
  control,
  onWithdraw,
  onRetry,
}: {
  control: QueuedControl;
  onWithdraw?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
}) {
  if (control.status === "failed") {
    return onRetry ? (
      <Button
        type="button"
        variant="quiet"
        size="meta"
        aria-label={t`Retry undo`}
        onClick={() => onRetry(control.id)}
      >
        <Trans>Retry</Trans>
      </Button>
    ) : null;
  }
  const withdrawing = control.status === "withdrawing";
  return (
    <>
      <span role="status" className="text-meta text-muted-foreground">
        {withdrawing ? t`Withdrawing undo` : t`Undo queued`}
      </span>
      {onWithdraw ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          aria-disabled={withdrawing || undefined}
          aria-label={t`Withdraw undo`}
          onClick={() => {
            if (!withdrawing) onWithdraw(control);
          }}
        >
          <Trans>Withdraw</Trans>
        </Button>
      ) : null}
    </>
  );
}

function DividerMark({ state, loud }: { state: DividerView["state"]; loud: boolean }) {
  if (state === "pending") return <span aria-hidden className="streaming-dot mx-1" />;
  if (loud) return <CircleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  const Icon = state === "undone" ? UnfoldVertical : FoldVertical;
  return <Icon aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(i18n.locale || undefined).format(value);
}
