/**
 * Writer controls waiting at the transcript tail.
 *
 * A control takes no transcript position until it runs (R5), so a queued
 * `/compact` sits after the newest turn as a dashed rule: the divider it will
 * become, not yet drawn. Withdraw is right after the words; the withdrawal's
 * outcome replaces the words on the same row. A handoff brief Retry renders
 * minimally here; its card is the handoff surface's.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert, FoldVertical } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QueuedControl } from "./thread-controls";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type QueuedControlRowsProps = {
  controls: readonly QueuedControl[];
  onWithdraw?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
};

function copyFor(control: QueuedControl): string {
  const kind = control.control.kind;
  switch (control.status) {
    case "queued":
    case "withdraw_failed":
      return kind === "compact"
        ? t`Compaction queued`
        : kind === "compaction_undo"
          ? t`Undo queued`
          : t`Handoff brief queued`;
    case "failed":
      return kind === "compact"
        ? t`Couldn't queue the compaction.`
        : kind === "compaction_undo"
          ? t`Couldn't queue the undo.`
          : t`Couldn't queue the handoff brief.`;
    case "withdrawing":
      return t`Withdrawing`;
    case "withdrawn":
      return kind === "compact"
        ? t`Compaction withdrawn`
        : kind === "compaction_undo"
          ? t`Undo withdrawn`
          : t`Handoff brief withdrawn`;
    case "stopping":
      return kind === "compact" ? t`Stopping compaction` : t`Stopping`;
    case "already_finished":
      return kind === "compact"
        ? t`This compaction already ran.`
        : kind === "compaction_undo"
          ? t`This undo already ran.`
          : t`This handoff brief already ran.`;
  }
}

function withdrawLabel(control: QueuedControl): string {
  return control.control.kind === "compact"
    ? t`Withdraw compaction`
    : control.control.kind === "compaction_undo"
      ? t`Withdraw undo`
      : t`Withdraw handoff brief`;
}

export function QueuedControlRows({ controls, onWithdraw, onRetry }: QueuedControlRowsProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const focusWithin = useFocusWithinRow(listRef);
  if (controls.length === 0) return null;
  return (
    <ul
      ref={listRef}
      tabIndex={-1}
      {...focusWithin}
      aria-label={t`Queued commands`}
      data-queued-controls
      className="flex flex-col gap-[var(--chat-space-inline)] py-[var(--chat-space-block)] outline-none"
    >
      {controls.map((control) => (
        <QueuedControlRow
          key={control.id}
          control={control}
          onWithdraw={onWithdraw}
          onRetry={onRetry}
        />
      ))}
    </ul>
  );
}

function QueuedControlRow({
  control,
  onWithdraw,
  onRetry,
}: {
  control: QueuedControl;
  onWithdraw?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
}) {
  const { status } = control;
  const failed = status === "failed";
  const canWithdraw = status === "queued" || status === "withdraw_failed";
  const settled = status === "withdrawn" || status === "already_finished" || status === "stopping";
  return (
    <li
      data-queued-control={control.control.kind}
      data-queued-control-status={status}
      className="flex min-w-0 flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)]"
    >
      <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
        {failed ? (
          <CircleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <FoldVertical aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
        )}
        <span
          role="status"
          className={cn(
            "text-caption",
            failed ? "text-destructive" : settled ? "text-ink-subtle" : "text-ink-muted",
          )}
        >
          {copyFor(control)}
        </span>
      </span>
      {failed && onRetry ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          onClick={() => onRetry(control.id)}
          aria-label={t`Retry queueing`}
        >
          <Trans>Retry</Trans>
        </Button>
      ) : null}
      {canWithdraw && onWithdraw ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          aria-label={withdrawLabel(control)}
          onClick={() => onWithdraw(control)}
        >
          <Trans>Withdraw</Trans>
        </Button>
      ) : null}
      {status === "withdraw_failed" ? (
        <span className="text-caption text-destructive">{t`Couldn't withdraw. Try again.`}</span>
      ) : null}
      <span
        aria-hidden
        className={cn(
          "min-w-6 flex-1 border-t border-dashed",
          settled ? "border-border-subtle" : "border-border",
        )}
      />
    </li>
  );
}
