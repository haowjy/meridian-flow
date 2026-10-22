/**
 * A surface's command footer, reserved below its rows so nothing it says inserts a line
 * above surviving content. It shows the latest command feedback (a Discard offers Undo; an
 * Apply that brought deleted documents back names them), or, while one is open, the
 * question a command asks first (Discard all, an Apply all that deletes or brings back
 * documents).
 */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef } from "react";
import { DraftCommandStatus } from "./DraftCommandStatus";
import type { WorkBranchCommands } from "./useWorkBranchCommands";

/** A command's question: the sentence, a way out, and the command itself. */
export type CommandQuestion = {
  kind: "discard" | "apply-all";
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

/**
 * The question an Apply all asks first, naming every document it will delete from the
 * manuscript and every one it brings back (D79).
 */
export function ApplyAllQuestion({
  deleting,
  restoring,
}: {
  deleting: readonly string[];
  restoring: readonly string[];
}) {
  useLingui();
  const list = (titles: readonly string[]) =>
    new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(titles);
  const deletes = list(deleting);
  const names = list(restoring);
  return (
    <>
      {deleting.length > 0 ? <Trans>Applying deletes {deletes}.</Trans> : null}
      {deleting.length > 0 && restoring.length > 0 ? " " : null}
      {restoring.length === 0 ? null : restoring.length === 1 ? (
        <Trans>Applying brings back {names}, which was deleted from the manuscript.</Trans>
      ) : (
        <Trans>Applying brings back {names}, which were deleted from the manuscript.</Trans>
      )}
    </>
  );
}

/** "‹title› is back in the manuscript.", with every name when an Apply all brought back several. */
export function restoredSentence(titles: readonly string[]): string {
  const names = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    titles,
  );
  return titles.length === 1
    ? t`${names} is back in the manuscript.`
    : t`${names} are back in the manuscript.`;
}

function RestoredSentence({ titles }: { titles: readonly string[] }) {
  useLingui();
  const sentence = restoredSentence(titles);
  return (
    <span className="min-w-0 truncate" title={sentence}>
      {sentence}
    </span>
  );
}
