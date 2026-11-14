/**
 * A draft owner's notice (`DraftNotices`) where a surface shows it: a Discard with its Undo, or
 * the documents an Apply brought back. `CommandNotice` is a surface's footer, which shows the
 * question an Apply all asks first in the notice's place while it is open.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { ActionNotice } from "@/components/app/ActionNotice";
import { documentDisplayName, documentLocationName } from "@/features/chat/document-display-name";
import {
  useAccountId,
  useDraftCommandOwner,
  useOptionalPresentedDocuments,
} from "@/features/project/context/account-feature-context";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useAiDraftLauncher } from "@/features/project/review-launch";
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
      className="flex min-h-7 coarse:min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-0.5 text-xs text-muted-foreground"
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
  const openDocument = useOpenProjectDocument(notice.projectId);
  if (notice.kind === "applied") {
    const [only] = notice.landed;
    const single = only && notice.landed.length === 1;
    const name = only ? documentDisplayName(only.uri) : "";
    // One landing names the document on its Open; the line says where it went. Several say it
    // once per place, so the line holds at sidebar width.
    const sentence = [
      ...(single ? [t`Now in ${placeOf(only.uri)}.`] : landedSentences(notice.landed)),
      appliedSentence(notice.restored, notice.renamed, notice.alsoApplied),
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <ActionNotice
        data-command-notice="applied"
        sentence={sentence}
        action={
          single
            ? {
                label: <Trans>Open {name}</Trans>,
                onClick: () => void openDocument({ documentId: only.documentId }),
              }
            : undefined
        }
        onDismiss={notice.dismiss}
        className={className}
      />
    );
  }
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
  const { subject } = notice;
  const { sentence, failedUndo } =
    subject.kind === "drafts"
      ? {
          sentence: t`${subject.count} drafts discarded.`,
          failedUndo: t`Couldn't bring back ${subject.count} drafts.`,
        }
      : subject.kind === "draft"
        ? {
            sentence: (name: string) => t`Draft of ${name} discarded.`,
            failedUndo: t`Couldn't bring back the draft of ${subject.name}.`,
          }
        : subject.kind === "folder"
          ? {
              sentence: (name: string) => t`Changes in ${name} discarded.`,
              failedUndo: t`Couldn't bring back the changes in ${subject.name}.`,
            }
          : {
              sentence: (name: string) => t`Change to ${name} discarded.`,
              failedUndo: t`Couldn't bring back the change to ${subject.name}.`,
            };
  const failed = notice.status === "failed";
  if (notice.status === "partial") {
    const count = notice.leftOut;
    return (
      <ActionNotice
        data-command-notice="undo-partial"
        sentence={plural(count, {
          one: "# change couldn't come back: it was drafted again or is gone.",
          other: "# changes couldn't come back: they were drafted again or are gone.",
        })}
        onDismiss={notice.dismiss}
        className={className}
      />
    );
  }
  return (
    <ActionNotice
      data-command-notice={failed ? "undo-failed" : "discarded"}
      sentence={sentence}
      name={subject.kind === "drafts" ? null : subject.name}
      action={{ label: <Trans>Undo</Trans>, onClick: undo, pending: notice.status === "undoing" }}
      onDismiss={notice.dismiss}
      failure={failed ? { message: failedUndo, onRetry: undo, onDismiss: notice.dismiss } : null}
      className={className}
    />
  );
}

/** A notice's action in `container` (Undo, Retry): where the focus goes when the notice took the pressed control's place. */
export const noticeAction = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-command-notice] button:not(:disabled)");

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

/** "Ch 3 and Outline are now in Manuscript/Arc 3.": one sentence per place, in landing order. */
function landedSentences(landed: readonly { uri: string }[]): string[] {
  const byPlace = new Map<string, string[]>();
  for (const { uri } of landed) {
    const place = placeOf(uri);
    byPlace.set(place, [...(byPlace.get(place) ?? []), documentDisplayName(uri)]);
  }
  const list = (names: readonly string[]) =>
    new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(names);
  return [...byPlace].map(([place, names]) => {
    const all = list(names);
    return names.length === 1 ? t`${all} is now in ${place}.` : t`${all} are now in ${place}.`;
  });
}

/** "Manuscript/Arc 3": the source and folder a document is in. */
function placeOf(uri: string): string {
  const whole = documentLocationName(uri);
  return whole.slice(0, whole.lastIndexOf("/")) || whole;
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
