/**
 * Writer commands that have not run yet.
 *
 * A pending write-mode switch is the write-mode notice at the transcript tail:
 * "Switched to auto-apply" while the next reply will apply it, "Switch to
 * auto-apply queued" while a reply that held the chat first has to finish. A
 * queued `/compact` sits there as a dashed rule, the divider it will become,
 * with the writer's instructions under it verbatim. Stop is right after the
 * words on every pending row from its first frame (disabled while the switch's
 * post is unanswered), and removes the row at once; it cancels the command the
 * way a switch back does. A failed enqueue the server may hold has Retry alone.
 * The rows carry no live region: `useThreadControls` and `useSwitchView` announce
 * each change through the global polite announcer, which also reaches a row
 * scrolled out of the virtualized list.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleAlert, FoldVertical } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CompactionInstructions } from "../compaction/CompactionInstructions";
import { useFocusWithinRow } from "../compaction/useFocusWithinRow";
import { controlRetryLabel, controlStatusCopy, controlStopLabel } from "./control-copy";
import type { QueuedControl } from "./thread-controls";
import { WriteModeNotice } from "./WriteModeNotice";

export type QueuedControlRowsProps = {
  controls: readonly QueuedControl[];
  onStop?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
};

export function QueuedControlRows({ controls, onStop, onRetry }: QueuedControlRowsProps) {
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
        <QueuedControlRow key={control.id} control={control} onStop={onStop} onRetry={onRetry} />
      ))}
    </ul>
  );
}

function QueuedControlRow({
  control,
  onStop,
  onRetry,
}: {
  control: QueuedControl;
  onStop?: (control: QueuedControl) => void;
  onRetry?: (controlId: string) => void;
}) {
  const { status } = control;
  const failed = status === "failed";
  const label = controlStatusCopy(control.control, status, control.waiting);
  const actions = (
    <>
      {failed && onRetry ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          onClick={() => onRetry(control.id)}
          aria-label={controlRetryLabel(control.control)}
        >
          <Trans>Retry</Trans>
        </Button>
      ) : null}
      {onStop && !(failed && control.awaitingServer) ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          // The row has Stop from its first frame so it never changes height. While the
          // post is in flight the server may hold the switch and hasn't said, so Stop waits.
          disabled={control.awaitingServer}
          aria-label={controlStopLabel(control.control)}
          onClick={() => onStop(control)}
        >
          <Trans>Stop</Trans>
        </Button>
      ) : null}
      {status === "withdraw_failed" ? (
        <span className="text-meta text-destructive">{t`Couldn't stop. Try again.`}</span>
      ) : null}
    </>
  );
  if (control.control.kind === "write_mode" && !failed) {
    return (
      <li data-queued-control="write_mode" data-queued-control-status={status} className="min-w-0">
        <WriteModeNotice mode={control.control.mode} label={label}>
          {actions}
        </WriteModeNotice>
      </li>
    );
  }
  const instructions =
    control.control.kind === "compact" && control.control.instructions?.trim()
      ? control.control.instructions
      : null;
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
          <span className={cn("text-meta", failed ? "text-destructive" : "text-ink-muted")}>
            {label}
          </span>
        </span>
        {actions}
        {control.control.kind === "compact" ? (
          <span aria-hidden className="min-w-6 flex-1 border-t border-dashed border-border" />
        ) : null}
      </div>
      {instructions ? <CompactionInstructions instructions={instructions} /> : null}
    </li>
  );
}
