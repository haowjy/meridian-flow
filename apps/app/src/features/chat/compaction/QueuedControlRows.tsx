/**
 * Writer commands waiting in the queue.
 *
 * A command runs only once no message waits, so a queued `/compact` sits at
 * the transcript tail, after every queued message, as a dashed rule: the
 * divider it will become, not yet drawn. The writer's instructions show under
 * it verbatim, at once. Withdraw is right after the
 * words on every row, a failed enqueue's too (beside its Retry), and removes
 * the row at once. There is no Stop on a queued row. The rows
 * carry no live region: `useThreadControls` announces each change through the
 * global polite announcer, which also reaches a row scrolled out of the
 * virtualized list.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert, FoldVertical } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CompactionInstructions } from "./CompactionInstructions";
import { controlStatusCopy } from "./control-copy";
import type { QueuedControl } from "./thread-controls";
import { useFocusWithinRow } from "./useFocusWithinRow";

export type QueuedControlRowsProps = {
  controls: readonly QueuedControl[];
  onWithdraw?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
};

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
  const instructions = control.control.instructions?.trim() ? control.control.instructions : null;
  return (
    <li
      data-queued-control={control.control.kind}
      data-queued-control-status={status}
      className="flex min-w-0 flex-col gap-[var(--chat-space-inline)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)]">
        <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
          {failed ? (
            <CircleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <FoldVertical aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
          )}
          <span className={cn("text-caption", failed ? "text-destructive" : "text-ink-muted")}>
            {controlStatusCopy(status)}
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
        {onWithdraw ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            aria-label={t`Withdraw compaction`}
            onClick={() => onWithdraw(control)}
          >
            <Trans>Withdraw</Trans>
          </Button>
        ) : null}
        {status === "withdraw_failed" ? (
          <span className="text-caption text-destructive">{t`Couldn't withdraw. Try again.`}</span>
        ) : null}
        <span aria-hidden className="min-w-6 flex-1 border-t border-dashed border-border" />
      </div>
      {instructions ? <CompactionInstructions instructions={instructions} /> : null}
    </li>
  );
}
