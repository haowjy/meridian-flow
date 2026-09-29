/**
 * Writer commands waiting at the transcript tail.
 *
 * A command runs only once replies finish, and takes no transcript position
 * until then, so a queued `/compact` or Undo sits after the newest turn as a
 * dashed rule: the divider it will become, not yet drawn. Messages sent after
 * it render above it; it stays last until it runs. Withdraw is right after the
 * words and removes the row at once. A command that already started says so
 * here until its divider shows. There is no Stop on a queued row: the
 * composer's Stop (Esc) runs the command at once. The rows carry no live
 * region: `useThreadControls` announces each change through the global polite
 * announcer, which also reaches a row scrolled out of the virtualized list.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert, FoldVertical, UnfoldVertical } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { controlStatusCopy } from "./control-copy";
import type { QueuedControl } from "./thread-controls";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type QueuedControlRowsProps = {
  controls: readonly QueuedControl[];
  onWithdraw?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
};

function withdrawLabel(control: QueuedControl): string {
  return control.control.kind === "compact" ? t`Withdraw compaction` : t`Withdraw undo`;
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
  const settled = status === "already_started";
  const Icon = control.control.kind === "compact" ? FoldVertical : UnfoldVertical;
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
          <Icon aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
        )}
        <span
          className={cn(
            "text-caption",
            failed ? "text-destructive" : settled ? "text-ink-subtle" : "text-ink-muted",
          )}
        >
          {controlStatusCopy(control.control.kind, status)}
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
