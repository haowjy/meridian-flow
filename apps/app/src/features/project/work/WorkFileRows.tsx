/** A new Scratch note awaiting creation, or refused with retry and dismiss actions. */
import { Trans } from "@lingui/react/macro";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { fileKindIcon } from "../context/context-file-icon";
import { RowIcon } from "../RuledList";
import type { NoteAttempt } from "./use-work-note-intake";

export function NoteAttemptRow({
  attempt,
  onRetry,
  onDismiss,
}: {
  attempt: NoteAttempt;
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 px-2 py-1.5 text-sm">
      <RowIcon icon={fileKindIcon(attempt.name)} />
      <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
        {attempt.name}
      </span>
      {attempt.state === "pending" ? (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          <Trans>Creating…</Trans>
        </span>
      ) : (
        <InlineErrorRow
          message={<Trans>Couldn’t create note</Trans>}
          onRetry={onRetry}
          onDismiss={onDismiss}
          className="shrink-0 p-0"
        />
      )}
    </div>
  );
}
