import { t } from "@lingui/core/macro";
import { FoldVertical } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { AnchoredCards } from "../ChatCards";
import { CompactionInstructions } from "../compaction/CompactionInstructions";
import { useFocusWithinRow } from "../compaction/useFocusWithinRow";
import { controlStatusCopy, controlWithdrawLabel, controlWithdrawText } from "./control-copy";
import type { QueuedControl } from "./thread-controls";
import { WriteModeNotice } from "./WriteModeNotice";

export type QueuedControlRowsProps = {
  controls: readonly QueuedControl[];
  onWithdraw?: (control: QueuedControl) => void;
};

export function QueuedControlRows({ controls, onWithdraw }: QueuedControlRowsProps) {
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
        <QueuedControlRow key={control.id} control={control} onWithdraw={onWithdraw} />
      ))}
    </ul>
  );
}

function QueuedControlRow({
  control,
  onWithdraw,
}: {
  control: QueuedControl;
  onWithdraw?: (control: QueuedControl) => void;
}) {
  const { status } = control;
  const failed = status === "failed";
  const label = controlStatusCopy(control.control, status, control.waiting);
  const actions = (
    <>
      {failed ? <AnchoredCards anchor={{ queuedControl: control.id }} /> : null}
      {status === "withdraw_failed" ? (
        <AnchoredCards anchor={{ queuedControl: control.id }} />
      ) : onWithdraw && !(failed && control.awaitingServer) ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          // The row has its withdraw button from its first frame so it never changes height. While
          // the post is in flight the server may hold the switch and hasn't said, so the button waits.
          disabled={control.awaitingServer}
          aria-label={controlWithdrawLabel(control.control)}
          onClick={() => onWithdraw(control)}
        >
          {controlWithdrawText(control.control)}
        </Button>
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
        {failed ? null : (
          <span className="flex min-w-0 items-center gap-[var(--chat-space-block)]">
            <FoldVertical aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{label}</span>
          </span>
        )}
        {actions}
        {control.control.kind === "compact" ? (
          <span aria-hidden className="min-w-6 flex-1 border-t border-dashed border-border" />
        ) : null}
      </div>
      {instructions ? <CompactionInstructions instructions={instructions} /> : null}
    </li>
  );
}
