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
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { ActionNotice } from "@/components/app/ActionNotice";
import { RowWord } from "@/components/app/RowWord";
import { documentDisplayName, documentLocationName } from "@/features/chat/document-display-name";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import type { AppliedFact, DraftNotice } from "./draft-notices";

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
 * One notice: "Chapter 1 discarded." or "Chapter 1 deleted." with Undo and a dismiss,
 * or what an Apply did: in a document's band, "Change applied to Live." with Undo, since the page
 * has no rows to say it.
 * An Undo that failed shows the pill toast, and the notice keeps its Undo. When main, the side or the phone's sheet still presents
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
  const openDocument = useOpenProjectDocument(notice.projectId);
  const landed = useLandedNow(notice);
  if (notice.kind === "applied") {
    if (notice.surface.kind === "band")
      return <BandAppliedLine notice={notice} className={className} />;
    if (landed.length === 0) return null;
    const [only] = landed;
    // The bare "Now in X." only when the Apply landed one document: with others it needs its name.
    const single = notice.facts.filter((fact) => fact.kind === "landed").length === 1;
    const name = documentDisplayName(only.uri);
    // One landing names the document on its Open; the line says where it went. Several say it
    // once per place, so the line holds at sidebar width.
    const sentence = (single ? [t`Now in ${placeOf(only.uri)}.`] : landedSentences(landed)).join(
      " ",
    );
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
  const { subject } = notice;
  // A failed Undo is the press's pill (`PressEntries`), said once.
  const onUndo = () => void notice.undo();
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
      action={{ label: <Trans>Undo</Trans>, onClick: onUndo, pending: notice.status === "undoing" }}
      onDismiss={notice.dismiss}
      className={className}
    />
  );
}

/** A band's Apply: one change, or the whole document, now in Live, with the press's Undo. */
function BandAppliedLine({
  notice,
  className,
}: {
  notice: Extract<DraftNotice, { kind: "applied" }>;
  className?: string;
}) {
  const step = notice.facts.find((fact) => fact.step)?.step;
  const [first] = notice.facts;
  if (!step || !first) return null;
  return (
    <ActionNotice
      data-command-notice="applied"
      sentence={
        notice.change ? t`Change applied to Live.` : (name: string) => t`${name} applied to Live.`
      }
      name={notice.change ? null : first.name}
      action={{ label: <Trans>Undo</Trans>, onClick: () => void step.undo() }}
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
  const whereabouts = useWhereabouts(notice?.projectId ?? "");
  if (!notice) return { held: () => false, word: () => null };
  if (notice.kind === "applied") {
    // An Apply's rows offer its Undo while it can be taken back: the notice ends with it.
    const factsOf = (id: string) => notice.facts.filter((fact) => fact.documentId === id);
    return {
      held: (id) => factsOf(id).length > 0,
      word: (id) => {
        const [first] = factsOf(id);
        const step = factsOf(id).find((fact) => fact.step)?.step;
        if (!first || !step) return null;
        const now = whereabouts(id);
        const name = now.kind === "placed" ? documentDisplayName(now.uri) : first.name;
        return (
          <RowWord
            label={t`Undo applying ${name}`}
            word={<Trans>Undo</Trans>}
            sentence={t`Applied`}
            onAction={() => void step.undo()}
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

/**
 * Where a document an Apply took is now, by its id in the project's tree: `placed` where the tree
 * has it, `removed` once it is in Trash or purged, and `unread` while the list can't say, when the
 * notice says where the Apply left it.
 */
type Whereabouts = { kind: "placed"; uri: string } | { kind: "removed" } | { kind: "unread" };

function useWhereabouts(projectId: string): (documentId: string) => Whereabouts {
  const trees = useProjectTrees(projectId);
  return (documentId) => {
    const place = trees.find(documentId);
    if (place) return { kind: "placed", uri: place.file.uri };
    const { kind } = trees.standing(documentId);
    return kind === "in-trash" || kind === "purged" ? { kind: "removed" } : { kind: "unread" };
  };
}

type Landed = Extract<AppliedFact, { kind: "landed" }>;

/**
 * What an Apply landed, each fact as its document stands now. A document gone since is left out:
 * there is nothing to say of where it landed. A notice that is not an Apply has none.
 */
function useLandedNow(notice: DraftNotice | null): Landed[] {
  const whereabouts = useWhereabouts(notice?.projectId ?? "");
  if (notice?.kind !== "applied") return [];
  return notice.facts.flatMap((fact) => {
    if (fact.kind !== "landed") return [];
    const now = whereabouts(fact.documentId);
    return now.kind === "removed" ? [] : [factNow(fact, now)];
  });
}

/** The notice, if it has a line to say: a plain Apply's is said only on its rows, and a landing in a document since deleted says nothing. */
export function useNoticeLine(notice: DraftNotice | null): DraftNotice | null {
  const landed = useLandedNow(notice);
  return notice && (notice.kind !== "applied" || landed.length > 0) ? notice : null;
}

/** The fact as the document stands now: a landing names where it is. */
function factNow(fact: Landed, now: Whereabouts): Landed {
  if (now.kind !== "placed") return fact;
  return { ...fact, uri: now.uri, name: documentDisplayName(now.uri) };
}

/** A notice's action in `container` (Undo, Retry): where the focus goes when the notice took the pressed control's place. */
export const noticeAction = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-command-notice] [data-row-word]:not(:disabled)") ??
  container.querySelector<HTMLElement>("[data-command-notice] button:not(:disabled)");

/** The question an Apply all asks first, naming every document it will delete. */
export function ApplyAllQuestion({ deleting }: { deleting: readonly string[] }) {
  useLingui();
  const deletes = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    deleting,
  );
  return <>{t`Applying deletes ${deletes}.`}</>;
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
