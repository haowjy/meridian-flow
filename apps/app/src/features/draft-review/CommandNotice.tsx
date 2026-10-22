/**
 * A surface's command footer, reserved below its rows so nothing it says inserts a line
 * above surviving content. It shows the latest command feedback (a Discard offers Undo; an
 * Apply that brought deleted documents back names them), or, while one is open, the
 * question a command asks first (Discard all, an Apply all that brings documents back).
 */
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef } from "react";
import { DraftCommandStatus } from "./DraftCommandStatus";
import type { WorkBranchCommands } from "./useWorkBranchCommands";

/** A command's question: the sentence, a way out, and the command itself. */
export type CommandQuestion = {
  kind: "discard" | "restore";
  sentence: ReactNode;
  keep: ReactNode;
  confirm: ReactNode;
  onKeep(): void;
  onConfirm(): void;
  disabled?: boolean;
};

export function CommandNotice({
  commands,
  question = null,
}: {
  commands: Pick<WorkBranchCommands, "notice" | "undoNotice">;
  question?: CommandQuestion | null;
}) {
  const { notice } = commands;
  const footer = useRef<HTMLDivElement>(null);
  // The group's menu may sit far above a long list: bring the question into view.
  const asking = question?.kind;
  useEffect(() => {
    if (asking) footer.current?.scrollIntoView?.({ block: "nearest" });
  }, [asking]);
  const button =
    "text-button shrink-0 disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
  return (
    <div
      ref={footer}
      className="flex min-h-7 [@media(pointer:coarse)]:min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-0.5 text-caption text-ink-muted"
      role="status"
      data-command-notice={question ? undefined : notice?.kind}
      data-command-question={question?.kind}
    >
      {question ? (
        <>
          <span className="min-w-0 flex-1 basis-48">{question.sentence}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" className={button} onClick={question.onKeep}>
              {question.keep}
            </button>
            <button
              type="button"
              className={button}
              disabled={question.disabled}
              onClick={question.onConfirm}
            >
              {question.confirm}
            </button>
          </span>
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

/** The question an Apply all asks before it brings deleted documents back (D79), naming each. */
export function RestoreQuestion({ titles }: { titles: readonly string[] }) {
  useLingui();
  const names = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    titles,
  );
  return titles.length === 1 ? (
    <Trans>Applying brings back {names}, which was deleted from the manuscript.</Trans>
  ) : (
    <Trans>Applying brings back {names}, which were deleted from the manuscript.</Trans>
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
