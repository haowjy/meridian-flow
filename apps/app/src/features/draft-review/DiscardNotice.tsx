/** Surface-local feedback in a reserved footer; it never inserts a row above surviving content. */
import { Trans } from "@lingui/react/macro";
import { DraftCommandStatus } from "./DraftCommandStatus";
import type { WorkBranchCommands } from "./useWorkBranchCommands";
export function DiscardNotice({
  commands,
}: {
  commands: Pick<WorkBranchCommands, "notice" | "undoNotice">;
}) {
  return (
    <div
      className="flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center gap-2 px-2 text-caption text-ink-muted"
      role="status"
      data-discard-notice={commands.notice?.kind}
    >
      {commands.notice?.itemKey ? <DraftCommandStatus itemKey={commands.notice.itemKey} /> : null}
      {commands.notice ? (
        <>
          <span>
            {commands.notice.kind === "removed" ? <Trans>Removed</Trans> : <Trans>Discarded</Trans>}
          </span>
          {commands.notice.undo ? (
            <button
              type="button"
              className="text-button [@media(pointer:coarse)]:min-h-11"
              onClick={commands.undoNotice}
            >
              <Trans>Undo</Trans>
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
