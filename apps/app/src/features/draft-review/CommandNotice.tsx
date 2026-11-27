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

type CommandQuestion = {
  kind: "apply-all";
  sentence: ReactNode;
  confirm: ReactNode;
  onKeep(): void;
  onConfirm(): void;
  disabled: boolean;
};

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

export function useDraftNotice(draftId: string): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => (draftId ? notices.get(draftId) : null),
    () => null,
  );
}

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
    if (!first) return null;
    if (notice.surface.kind === "strip")
      return (
        <ActionNotice
          data-command-notice="applied"
          sentence={plural(notice.documents.length, {
            one: "# document applied.",
            other: "# documents applied.",
          })}
          action={{ label: <Trans>Undo</Trans>, onClick: notice.undo }}
          onDismiss={notice.dismiss}
          className={className}
        />
      );
    if (notice.surface.kind !== "page") return null;
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
  held: (id: string) => boolean;
  word: (id: string) => ReactNode;
};

const focused = new Set<number>();
const takeOnce = (id: number) => !focused.has(id) && Boolean(focused.add(id));

export function useDraftNoticeWords(notice: DraftNotice | null): DraftNoticeWords {
  useLingui();
  const trees = useProjectTrees(notice?.projectId ?? "");
  if (!notice) return { held: () => false, word: () => null };
  if (notice.kind === "applied") {
    const visible = notice.wholeDraft ? notice.documents.slice(0, 1) : notice.documents;
    const documentOf = (id: string) => visible.find((each) => each.documentId === id);
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

export const noticeAction = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-command-notice] [data-row-word]:not(:disabled)") ??
  container.querySelector<HTMLElement>("[data-command-notice] button:not(:disabled)");

function ApplyAllQuestion({ deleting }: { deleting: readonly string[] }) {
  useLingui();
  const deletes = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    deleting,
  );
  return <>{t`Applying deletes ${deletes}.`}</>;
}
