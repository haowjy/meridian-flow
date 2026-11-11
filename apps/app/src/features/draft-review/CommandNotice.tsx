/**
 * A draft owner's notice (`DraftNotices`) where a surface shows it: a Discard with its Undo, or
 * the documents an Apply brought back. `CommandNotice` is a surface's footer, which shows the
 * question an Apply all asks first in the notice's place while it is open.
 */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import {
  useAccountId,
  useDraftCommandOwner,
  useOptionalPresentedDocuments,
} from "@/features/project/context/account-feature-context";
import { useAiDraftLauncher } from "@/features/project/review-launch";
import { cn } from "@/lib/utils";
import type { DraftNotice } from "./draft-notices";

/** Apply all's question: the sentence, a way out, and the command itself. */
export type CommandQuestion = {
  kind: "apply-all";
  sentence: ReactNode;
  keep: ReactNode;
  confirm: ReactNode;
  onKeep(): void;
  onConfirm(): void;
  disabled?: boolean;
};

/** The owner's notice, wherever it was made; the caller shows it if it was made there. */
export function useDraftNotice(ownerKey: string): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => (ownerKey ? notices.get(ownerKey) : null),
    () => null,
  );
}

/**
 * The Discard notice a document's identity row shows, or with `documentId` null the one the
 * Recently opened landing shows (`DraftNotices.forDocument`).
 */
export function useDocumentNotice(
  projectId: string,
  documentId: string | null,
): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => notices.forDocument(projectId, documentId),
    () => null,
  );
}

export function CommandNotice({
  notice,
  question = null,
}: {
  notice: DraftNotice | null;
  question?: CommandQuestion | null;
}) {
  const footer = useRef<HTMLDivElement>(null);
  // The group's menu may sit far above a long list: bring the question into view.
  const asking = question?.kind;
  useEffect(() => {
    if (asking) footer.current?.scrollIntoView?.({ block: "nearest" });
  }, [asking]);
  if (!question && !notice) return null;
  const button = "text-button shrink-0 text-xs disabled:opacity-50 coarse:min-h-11 coarse:min-w-11";
  if (!question && notice) return <DraftNoticeLine notice={notice} />;
  return (
    <div
      ref={footer}
      className="flex min-h-7 coarse:min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-0.5 text-caption text-muted-foreground"
      role="status"
      data-command-question={question?.kind}
    >
      <span className="min-w-0 flex-1 basis-48">{question?.sentence}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" className={button} onClick={question?.onKeep}>
          {question?.keep}
        </button>
        <button
          type="button"
          className={button}
          disabled={question?.disabled}
          onClick={question?.onConfirm}
        >
          {question?.confirm}
        </button>
      </span>
    </div>
  );
}

/**
 * One notice: "Draft of Chapter 1 discarded." with Undo and a dismiss, or what an Apply did.
 * An Undo that failed stays, with Retry. When main, the side or the phone's sheet still presents
 * the document the Discard left there, an Undo returns that view to the draft; anywhere else
 * nothing moves.
 */
export function DraftNoticeLine({
  notice,
  className,
}: {
  notice: DraftNotice;
  className?: string;
}) {
  useLingui();
  const presented = useOptionalPresentedDocuments();
  const accountId = useAccountId();
  const { openReviewFile } = useAiDraftLauncher();
  const dismiss = (
    <IconButton label={t`Dismiss`} className="shrink-0" onClick={notice.dismiss}>
      <X aria-hidden className="size-3" />
    </IconButton>
  );
  if (notice.kind === "applied")
    return (
      <div
        role="status"
        data-command-notice="applied"
        className={cn(
          "flex min-h-7 coarse:min-h-11 min-w-0 items-center gap-x-2 px-2 py-0.5 text-caption text-muted-foreground",
          className,
        )}
      >
        <AppliedSentence
          restored={notice.restored}
          renamed={notice.renamed}
          alsoApplied={notice.alsoApplied}
        />
        {dismiss}
      </div>
    );
  const undo = () => {
    const { review, left, projectId, ownerKey } = notice;
    // Where main was when the notice showed (null: Recently opened); the view follows only
    // if main is still there.
    const stays = left ? left.landed : review?.documentId;
    void notice.undo().then((answer) => {
      if (answer !== "ok" || !review || stays === undefined || !presented) return;
      if (presented.mainDocumentId(projectId) === stays) openReviewFile(review, ownerKey);
      // Beside main the address is main's: only the document's view changes.
      else if (stays !== null && presented.isPresented(projectId, stays))
        setDocumentView(accountId, projectId, stays, {
          pin: { ownerKey, itemKey: review.draft.itemKey },
        });
    });
  };
  if (notice.status === "failed")
    return (
      <div role="status" data-command-notice="undo-failed" className={className}>
        <InlineErrorRow
          message={t`Couldn't undo. Try again.`}
          onRetry={undo}
          onDismiss={notice.dismiss}
        />
      </div>
    );
  const { subject } = notice;
  const sentence =
    subject.kind === "drafts"
      ? t`${subject.count} drafts discarded.`
      : subject.kind === "draft"
        ? t`Draft of ${subject.name} discarded.`
        : t`Change to ${subject.name} discarded.`;
  return (
    <div
      role="status"
      data-command-notice="discarded"
      className={cn(
        "flex min-h-7 coarse:min-h-11 min-w-0 items-center gap-x-2 px-2 py-0.5 text-caption text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0 truncate" title={sentence}>
        {sentence}
      </span>
      <button
        type="button"
        className="text-button shrink-0 text-xs disabled:opacity-50 coarse:min-h-11"
        disabled={notice.status === "undoing"}
        onClick={undo}
      >
        <Trans>Undo</Trans>
      </button>
      {dismiss}
    </div>
  );
}

/**
 * The question an Apply all asks first, naming every document it will delete from the
 * manuscript and every one it brings back.
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

function AppliedSentence({
  restored,
  renamed,
  alsoApplied,
}: {
  restored: readonly string[];
  renamed: readonly string[];
  alsoApplied: readonly string[];
}) {
  useLingui();
  const sentence = appliedSentence(restored, renamed, alsoApplied);
  return (
    <span className="min-w-0 truncate" title={sentence}>
      {sentence}
    </span>
  );
}

export function appliedSentence(
  restored: readonly string[],
  renamed: readonly string[],
  alsoApplied: readonly string[] = [],
): string {
  const others = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    alsoApplied,
  );
  return [
    ...(renamed.length === 1
      ? [t`Added as ${renamed[0]}.`]
      : renamed.map((name) => t`Added as ${name}.`)),
    ...(restored.length ? [restoredSentence(restored)] : []),
    ...(alsoApplied.length ? [t`Also applied ${others}.`] : []),
  ].join(" ");
}
