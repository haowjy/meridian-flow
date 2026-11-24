/**
 * A draft owner's notice (`DraftNotices`) where a surface shows it: a Discard or an Apply, with
 * its Undo. `CommandNotice` is a surface's footer, which shows the
 * question an Apply all asks first in the notice's place while it is open.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { type ReviewFileTarget, reviewFileTargetName } from "@/client/query/work-draft-files";
import { ActionNotice } from "@/components/app/ActionNotice";
import { RowWord } from "@/components/app/RowWord";
import { documentDisplayName } from "@/features/chat/document-display-name";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import type { DraftNotice } from "./draft-notices";

/** Apply all's question: the sentence, a way out, and the command itself. */
type CommandQuestion = {
  kind: "apply-all";
  sentence: ReactNode;
  confirm: ReactNode;
  onKeep(): void;
  onConfirm(): void;
  disabled: boolean;
};

/**
 * Apply all, which asks first when it deletes documents (`deleting`), naming them. `question`
 * goes to the surface's `CommandNotice`, in the footer below its files: opening it never moves a
 * row.
 */
export function useApplyAllQuestion({
  deleting,
  apply,
  confirm,
  disabled,
}: {
  deleting: readonly ReviewFileTarget[];
  apply: () => void;
  confirm: ReactNode;
  disabled: boolean;
}) {
  const [asking, setAsking] = useState<readonly string[] | null>(null);
  const untitled = t`Untitled document`;
  const cancel = useCallback(() => setAsking(null), []);
  const question: CommandQuestion | null = asking
    ? {
        kind: "apply-all",
        sentence: <ApplyAllQuestion deleting={asking} />,
        confirm,
        onKeep: cancel,
        onConfirm: () => {
          setAsking(null);
          apply();
        },
        disabled,
      }
    : null;
  return {
    question,
    cancel,
    start: () =>
      deleting.length > 0
        ? setAsking(deleting.map((file) => reviewFileTargetName(file, untitled)))
        : apply(),
  };
}

/** The owner's notice, wherever it was made; the caller shows it if it was made there. */
export function useDraftNotice(draftId: string): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => (draftId ? notices.get(draftId) : null),
    () => null,
  );
}

/**
 * The notice a surface acting on several drafts shows (`WorkDraftCommands.noticeKeys`): a press
 * ends the surface's last notice, so at most one of them holds one.
 */
export function useSurfaceNotice(keys: readonly string[]): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => {
      for (const key of keys) {
        const notice = notices.get(key);
        if (notice) return notice;
      }
      return null;
    },
    () => null,
  );
}

/**
 * The notice a document's page shows on the draft it shows (`draftId`, null on Live), or with
 * `documentId` null the one the Recently opened landing shows (`DraftNotices.forDocument`).
 */
export function useDocumentNotice(
  projectId: string,
  documentId: string | null,
  draftId: string | null = null,
): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => notices.forDocument(projectId, documentId, draftId),
    () => null,
  );
}

/** The Discard notice that can bring `documentId` back (`DraftNotices.discarding`). */
export function useDiscardingNotice(documentId: string | null): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => (documentId ? notices.discarding(documentId) : null),
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
          <Trans>Cancel</Trans>
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
 * One notice: "Chapter 1 discarded." or "Chapter 1 deleted." with Undo and a dismiss, or on a
 * document's page what an Apply did, "Change applied to Live." with Undo, since the page has no
 * rows to say it; elsewhere an Apply speaks only on its rows. An Undo that failed shows the pill
 * toast, and the notice keeps its Undo.
 */
export function DraftNoticeLine({
  notice,
  className,
}: {
  notice: DraftNotice;
  className?: string;
}) {
  useLingui();
  if (notice.kind === "applied") {
    const [first] = notice.documents;
    if (notice.surface.kind !== "page" || !first) return null;
    return (
      <ActionNotice
        data-command-notice="applied"
        sentence={
          notice.change ? t`Change applied to Live.` : (name: string) => t`${name} applied to Live.`
        }
        name={notice.change ? null : first.name}
        action={{ label: <Trans>Undo</Trans>, onClick: notice.undo }}
        onDismiss={notice.dismiss}
        className={className}
      />
    );
  }
  const { subject } = notice;
  const sentence =
    subject.kind === "drafts"
      ? plural(subject.count, { one: "# document discarded.", other: "# documents discarded." })
      : subject.kind === "deletes"
        ? plural(subject.count, { one: "# item deleted.", other: "# items deleted." })
        : subject.kind === "deleted"
          ? (name: string) => t`${name} deleted.`
          : subject.kind === "change"
            ? t`Change discarded.`
            : (name: string) => t`${name} discarded.`;
  return (
    <ActionNotice
      data-command-notice="discarded"
      sentence={sentence}
      name={"name" in subject ? subject.name : null}
      action={{
        label: <Trans>Undo</Trans>,
        onClick: () => void notice.undo(),
        pending: notice.status === "undoing",
      }}
      onDismiss={notice.dismiss}
      className={className}
    />
  );
}

type DraftNoticeWords = {
  /** The row (a document's or folder's id) is one the notice speaks for. */
  held: (id: string) => boolean;
  /** The word that row shows, or null. */
  word: (id: string) => ReactNode;
};

/**
 * A notice said on the rows it concerns (`RowWord`), for a list that has rows: a Discard's Undo
 * on every row it took, or each fact an Apply brought on its document's row.
 */
const focused = new Set<number>();
const takeOnce = (id: number) => !focused.has(id) && Boolean(focused.add(id));

export function useDraftNoticeWords(notice: DraftNotice | null): DraftNoticeWords {
  useLingui();
  const trees = useProjectTrees(notice?.projectId ?? "");
  if (!notice) return { held: () => false, word: () => null };
  if (notice.kind === "applied") {
    // An Apply's rows offer its Undo while it can be taken back: the notice ends with it.
    const documentOf = (id: string) => notice.documents.find((each) => each.documentId === id);
    return {
      held: (id) => documentOf(id) !== undefined,
      word: (id) => {
        const first = documentOf(id);
        if (!first) return null;
        const uri = trees.find(id)?.file.uri;
        const name = uri ? documentDisplayName(uri) : first.name;
        return (
          <RowWord
            label={t`Undo applying ${name}`}
            word={<Trans>Undo</Trans>}
            sentence={t`Applied`}
            onAction={notice.undo}
            // The pressed ✓ or Apply all left with its row: the first row the Apply took has
            // the focus, as a delete's Undo does.
            focus={{ take: () => takeOnce(notice.id) }}
          />
        );
      },
    };
  }
  const took = (id: string) => notice.documentIds.includes(id);
  const { subject } = notice;
  const count = "count" in subject ? subject.count : 1;
  const name = "name" in subject ? subject.name : "";
  return {
    held: took,
    word: (id) => {
      if (!took(id)) return null;
      return (
        <RowWord
          word={<Trans>Undo</Trans>}
          label={count > 1 ? t`Undo discard of ${count} changes` : t`Undo discard of ${name}`}
          sentence={t`Discarded`}
          pending={notice.status === "undoing"}
          onAction={() => void notice.undo()}
        />
      );
    },
  };
}

/** A notice's action in `container` (Undo, Retry): where the focus goes when the notice took the pressed control's place. */
export const noticeAction = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-command-notice] [data-row-word]:not(:disabled)") ??
  container.querySelector<HTMLElement>("[data-command-notice] button:not(:disabled)");

/** The question an Apply all asks first, naming every document it will delete. */
function ApplyAllQuestion({ deleting }: { deleting: readonly string[] }) {
  useLingui();
  const deletes = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    deleting,
  );
  return <>{t`Applying deletes ${deletes}.`}</>;
}
