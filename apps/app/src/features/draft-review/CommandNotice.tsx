/**
 * A surface's latest command feedback in a reserved footer; it never inserts a row above
 * surviving content. A Discard offers Undo; an Apply that brought deleted documents back
 * names them.
 */
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { DraftCommandStatus } from "./DraftCommandStatus";
import type { WorkBranchCommands } from "./useWorkBranchCommands";
export function CommandNotice({
  commands,
}: {
  commands: Pick<WorkBranchCommands, "notice" | "undoNotice">;
}) {
  const { notice } = commands;
  return (
    <div
      className="flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center gap-2 px-2 text-caption text-ink-muted"
      role="status"
      data-command-notice={notice?.kind}
    >
      {notice?.itemKey ? <DraftCommandStatus itemKey={notice.itemKey} /> : null}
      {notice?.kind === "restored" ? (
        <RestoredSentence titles={notice.titles} />
      ) : notice ? (
        <>
          <span>
            {notice.kind === "removed" ? <Trans>Removed</Trans> : <Trans>Discarded</Trans>}
          </span>
          {notice.undo ? (
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

/** "‹title› is back in the manuscript.", with every name when an Apply all brought back several. */
export function RestoredSentence({ titles }: { titles: readonly string[] }) {
  useLingui();
  const names = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    titles,
  );
  return (
    <span className="min-w-0 truncate" title={names}>
      {titles.length === 1 ? (
        <Trans>{names} is back in the manuscript.</Trans>
      ) : (
        <Trans>{names} are back in the manuscript.</Trans>
      )}
    </span>
  );
}
