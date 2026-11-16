/**
 * A draft owner's notice (`DraftNotices`) where a surface shows it: a Discard with its Undo, or
 * the documents an Apply brought back. `CommandNotice` is a surface's footer, which shows the
 * question an Apply all asks first in the notice's place while it is open.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import { ActionNotice } from "@/components/app/ActionNotice";
import { RowWord } from "@/components/app/RowWord";
import { WorkClosedChip } from "@/components/app/WorkClosedChip";
import { documentDisplayName, documentLocationName } from "@/features/chat/document-display-name";
import {
  useAccountId,
  useDraftCommandOwner,
  useOptionalPresentedDocuments,
} from "@/features/project/context/account-feature-context";
import { schemeLabel } from "@/features/project/context/context-schemes";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { type Removal, removalSentence } from "@/features/project/context/RemovedDocumentNotice";
import { removalAnswer } from "@/features/project/context/removal-answer";
import { useAiDraftLauncher } from "@/features/project/review-launch";
import { type AppliedFact, type DraftNotice, hasLine, type RestoreReturned } from "./draft-notices";

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

/** The notice on one change card of a document (`DraftNotices.forCard`). */
export function useCardNotice(projectId: string, documentId: string | null): DraftNotice | null {
  const { notices } = useDraftCommandOwner();
  return useSyncExternalStore(
    notices.subscribe,
    () => (documentId ? notices.forCard(projectId, documentId) : null),
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
 * One notice: "Draft of Chapter 1 discarded." or "Chapter 1 deleted." with Undo and a dismiss,
 * or what an Apply did.
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
  const undo = useNoticeUndo();
  const openDocument = useOpenProjectDocument(notice.projectId);
  const whereabouts = useWhereabouts(notice.projectId);
  if (!hasLine(notice)) return null;
  if (notice.kind === "applied") {
    // A document gone since says so once, in place of what the Apply did to it.
    const removed = new Map<string, Removal>();
    const facts = notice.facts.flatMap((fact): AppliedFact[] => {
      if (fact.kind === "applied") return [];
      const now = whereabouts(fact.documentId, factName(fact));
      if (now.kind !== "removed") return [factNow(fact, now)];
      removed.set(fact.documentId, now.removal);
      return [];
    });
    const landed = facts.flatMap((fact) => (fact.kind === "landed" ? [fact] : []));
    const restored = facts.flatMap((fact) => (fact.kind === "restored" ? [fact] : []));
    const also = facts.flatMap((fact) =>
      fact.kind === "also" ? [`${fact.from} → ${fact.to}`] : [],
    );
    const [only] = landed;
    // The bare "Now in X." only when the Apply landed one document: with others it needs its name.
    const single = only && notice.facts.filter((fact) => fact.kind === "landed").length === 1;
    const name = only ? documentDisplayName(only.uri) : "";
    // One landing names the document on its Open; the line says where it went. Several say it
    // once per place, so the line holds at sidebar width.
    const sentence = [
      ...(single ? [t`Now in ${placeOf(only.uri)}.`] : landedSentences(landed)),
      appliedSentence(restored, also),
      removalSentence([...removed.values()]),
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
  const { subject } = notice;
  const onUndo = () => undo(notice);
  const sentence =
    subject.kind === "drafts"
      ? t`${subject.count} drafts discarded.`
      : subject.kind === "deletes"
        ? t`${subject.count} items deleted.`
        : subject.kind === "deleted"
          ? (name: string) => t`${name} deleted.`
          : subject.kind === "draft"
            ? (name: string) => t`Draft of ${name} discarded.`
            : subject.kind === "folder"
              ? (name: string) => t`Changes in ${name} discarded.`
              : (name: string) => t`Change to ${name} discarded.`;
  const failed = notice.status === "failed";
  if (notice.status === "returned") {
    return (
      <ActionNotice
        data-command-notice="undo-returned"
        sentence={restoreReturnedSentence(notice.returned)}
        onDismiss={notice.dismiss}
        className={className}
      />
    );
  }
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
  const first = notice.appliedFirst.length;
  const named = "name" in subject ? subject.name : "";
  const said = typeof sentence === "function" ? sentence(named) : sentence;
  return (
    <ActionNotice
      data-command-notice={failed ? "undo-failed" : "discarded"}
      sentence={
        first === 0
          ? sentence
          : typeof sentence === "function"
            ? (name: string) => `${sentence(name)} ${appliedFirstLine(first)}`
            : `${sentence} ${appliedFirstLine(first)}`
      }
      name={"name" in subject ? subject.name : null}
      action={{ label: <Trans>Undo</Trans>, onClick: onUndo, pending: notice.status === "undoing" }}
      onDismiss={notice.dismiss}
      failure={
        failed
          ? {
              // Away from the rows, the line still says which Undo failed.
              message: `${said} ${t`Undo didn't go through. Try again.`}`,
              onRetry: onUndo,
              onDismiss: notice.dismiss,
            }
          : null
      }
      className={className}
    />
  );
}

type Discarded = Extract<DraftNotice, { kind: "discarded" }>;

/**
 * A Discard notice's Undo. When main, the side or the phone's sheet still presents the document
 * the Discard left there, the view returns to the draft; anywhere else nothing moves.
 */
function useNoticeUndo() {
  const presented = useOptionalPresentedDocuments();
  const accountId = useAccountId();
  const { openReviewFile } = useAiDraftLauncher();
  return (notice: Discarded) => {
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
}

/** What a Discard says of the changes an Apply took before it reached them. */
function appliedFirstSentence(count: number): string {
  return plural(count, {
    one: "Applied before your Discard reached it, so it stays applied.",
    other: "# changes were applied before your Discard reached them, so they stay applied.",
  });
}

/** The same said on a notice's line, beside what the Discard took: it names how many. */
function appliedFirstLine(count: number): string {
  return plural(count, {
    one: "# change was applied before your Discard reached it.",
    other: "# changes were applied before your Discard reached them.",
  });
}

/**
 * What a Discard that a closed owner returned leaves on the control pressed, in its trailing
 * slot so it adds no height (`DraftNotices.showBounce`). Nothing for any other notice.
 */
export function BounceChip({ notice }: { notice: DraftNotice | null }) {
  useLingui();
  if (notice?.kind !== "discarded" || notice.status !== "bounced") return null;
  if (notice.returned === null)
    return (
      <WorkClosedChip
        label={<Trans>Applied first</Trans>}
        sentence={appliedFirstSentence(notice.appliedFirst.length)}
      />
    );
  const chat = notice.returned === "chat-in-trash";
  return (
    <WorkClosedChip
      label={chat ? <Trans>Its chat is in Trash</Trans> : undefined}
      sentence={
        chat
          ? t`Its chat is in Trash, so nothing was discarded. Restore the chat to discard its changes.`
          : t`Work was closed, so nothing was discarded. Unarchive or restore the Work to discard its changes.`
      }
    />
  );
}

export type DraftNoticeWords = {
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
  const undo = useNoticeUndo();
  const whereabouts = useWhereabouts(notice?.projectId ?? "");
  if (!notice) return { held: () => false, word: () => null };
  if (notice.kind === "applied") {
    const factsOf = (id: string) => notice.facts.filter((fact) => fact.documentId === id);
    return {
      held: (id) => factsOf(id).length > 0,
      word: (id) => {
        const facts = factsOf(id);
        const [first] = facts;
        if (!first) return null;
        const now = whereabouts(id, factName(first));
        const name = now.kind === "placed" ? documentDisplayName(now.uri) : factName(first);
        const said =
          now.kind === "removed"
            ? removalSentence([now.removal])
            : facts.map((fact) => factSentence(factNow(fact, now))).join(" ");
        const step = facts.find((fact) => fact.step)?.step;
        if (step) {
          const count = step.count;
          return (
            <RowWord
              label={t`Undo applying ${name}`}
              word={<Trans>Undo</Trans>}
              sentence={`${said} ${
                count > 1
                  ? t`Undo takes back the whole Apply, all ${count} changes.`
                  : t`Undo takes back the Apply.`
              }`}
              onAction={step.undo}
              // The pressed ✓ or Apply all left with its row: the first row the Apply took has
              // the focus, as a delete's Undo does.
              focus={{ take: () => takeOnce(notice.id) }}
            />
          );
        }
        return (
          <RowWord
            tone="done"
            label={t`${name}, applied`}
            word={<Trans>Applied</Trans>}
            sentence={said}
          />
        );
      },
    };
  }
  const took = (id: string) => notice.documentIds.includes(id);
  const appliedFirst = (id: string) => notice.appliedFirst.includes(id);
  const { subject } = notice;
  const count = "count" in subject ? subject.count : 1;
  const name = "name" in subject ? subject.name : "";
  return {
    held: (id) => took(id) || appliedFirst(id),
    word: (id) => {
      if (appliedFirst(id))
        return (
          <RowWord
            tone="done"
            word={<Trans>Applied first</Trans>}
            sentence={appliedFirstSentence(1)}
          />
        );
      if (!took(id)) return null;
      if (notice.status === "bounced") return <BounceChip notice={notice} />;
      if (notice.status === "returned")
        return (
          <RowWord
            tone="warning"
            word={<Trans>Not restored</Trans>}
            sentence={restoreReturnedSentence(notice.returned)}
          />
        );
      if (notice.status === "partial") {
        const left = notice.leftOut;
        return (
          <RowWord
            tone="warning"
            word={<Trans>Partly restored</Trans>}
            sentence={plural(left, {
              one: "# change couldn't come back: it was drafted again or is gone.",
              other: "# changes couldn't come back: they were drafted again or are gone.",
            })}
          />
        );
      }
      if (notice.status === "failed")
        return (
          <RowWord
            tone="warning"
            word={<Trans>Retry</Trans>}
            label={
              count > 1 ? t`Retry bringing back ${count} changes` : t`Retry bringing back ${name}`
            }
            sentence={t`Undo didn't go through. Try again.`}
            onAction={() => undo(notice)}
          />
        );
      return (
        <RowWord
          word={<Trans>Undo</Trans>}
          label={count > 1 ? t`Undo discard of ${count} changes` : t`Undo discard of ${name}`}
          sentence={
            count > 1
              ? t`Discarded ${count} changes just now. Undo brings them all back.`
              : subject.kind === "folder"
                ? t`Discarded the changes in ${name} just now. Undo brings them back.`
                : t`Discarded just now. Undo brings it back.`
          }
          pending={notice.status === "undoing"}
          onAction={() => undo(notice)}
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
type Whereabouts =
  | { kind: "placed"; uri: string }
  | { kind: "removed"; removal: Removal }
  | { kind: "unread" };

function useWhereabouts(projectId: string): (documentId: string, name: string) => Whereabouts {
  const trees = useProjectTrees(projectId);
  return (documentId, name) => {
    const place = trees.find(documentId);
    if (place) return { kind: "placed", uri: place.file.uri };
    const standing = trees.standing(documentId);
    if (standing.kind !== "in-trash" && standing.kind !== "purged") return { kind: "unread" };
    const answer = removalAnswer(standing);
    const title = standing.kind === "in-trash" ? standing.node.name : name;
    return {
      kind: "removed",
      removal: { title, record: answer?.kind === "removed" ? answer.record : null },
    };
  };
}

const factName = (fact: AppliedFact) => (fact.kind === "also" ? fact.to : fact.name);

/** The fact as the document stands now: a landing names where it is, a return its name. */
function factNow(fact: AppliedFact, now: Whereabouts): AppliedFact {
  if (now.kind !== "placed") return fact;
  if (fact.kind === "landed") return { ...fact, uri: now.uri, name: documentDisplayName(now.uri) };
  if (fact.kind === "restored") return { ...fact, name: documentDisplayName(now.uri) };
  return fact;
}

/** What one fact of an Apply says on its document's row. */
function factSentence(fact: AppliedFact): string {
  switch (fact.kind) {
    case "landed": {
      const place = placeOf(fact.uri);
      return t`Applied. Now in ${place}.`;
    }
    case "applied": {
      const area = schemeLabel(fact.scheme);
      return area ? t`Applied just now: its changes are in ${area}.` : t`Applied just now.`;
    }
    case "restored": {
      const area = schemeLabel(fact.scheme);
      return area ? t`Applied. It is back in ${area}.` : t`Applied. It is back.`;
    }
    case "also": {
      const { from, to } = fact;
      return t`Applied with the others: ${from} → ${to}.`;
    }
  }
}

/** What a restore that did nothing says, wherever it was sent from. */
export function restoreReturnedSentence(why: RestoreReturned | null): string {
  switch (why) {
    case "work-closed":
      return t`Work was closed.`;
    case "chat-in-trash":
      return t`Its chat is in Trash.`;
    default:
      return t`Gone from Trash.`;
  }
}

/** A notice's action in `container` (Undo, Retry): where the focus goes when the notice took the pressed control's place. */
export const noticeAction = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-command-notice] [data-row-word]:not(:disabled)") ??
  container.querySelector<HTMLElement>("[data-command-notice] button:not(:disabled)");

/** A document named in a sentence, with the source it is (or was) in. */
export type InArea = { name: string; scheme: ProjectContextTreeScheme | null | undefined };

/** The names joined per area, in the order each area first appears. */
function byArea(
  documents: readonly InArea[],
): { area: string | null; names: string; count: number }[] {
  const groups = new Map<string | null, string[]>();
  for (const { name, scheme } of documents) {
    const area = schemeLabel(scheme);
    groups.set(area, [...(groups.get(area) ?? []), name]);
  }
  const list = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" });
  return [...groups].map(([area, names]) => ({
    area,
    names: list.format(names),
    count: names.length,
  }));
}

/**
 * The question an Apply all asks first, naming every document it will delete and every one it
 * brings back, with the area it was deleted from.
 */
export function ApplyAllQuestion({
  deleting,
  restoring,
}: {
  deleting: readonly string[];
  restoring: readonly InArea[];
}) {
  useLingui();
  const deletes = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    deleting,
  );
  const sentences = [
    ...(deleting.length > 0 ? [t`Applying deletes ${deletes}.`] : []),
    ...byArea(restoring).map(({ area, names, count }) =>
      area
        ? count === 1
          ? t`Applying brings back ${names}, which was deleted from ${area}.`
          : t`Applying brings back ${names}, which were deleted from ${area}.`
        : count === 1
          ? t`Applying brings back ${names}, which was deleted.`
          : t`Applying brings back ${names}, which were deleted.`,
    ),
  ];
  return <>{sentences.join(" ")}</>;
}

/** "‹title› is back in Knowledge.": one sentence per area an Apply brought documents back to. */
function restoredSentence(restored: readonly InArea[]): string {
  return byArea(restored)
    .map(({ area, names, count }) =>
      area
        ? count === 1
          ? t`${names} is back in ${area}.`
          : t`${names} are back in ${area}.`
        : count === 1
          ? t`${names} is back.`
          : t`${names} are back.`,
    )
    .join(" ");
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
  restored: readonly InArea[],
  alsoApplied: readonly string[] = [],
): string {
  const others = new Intl.ListFormat(i18n.locale || undefined, { type: "conjunction" }).format(
    alsoApplied,
  );
  return [
    ...(restored.length ? [restoredSentence(restored)] : []),
    ...(alsoApplied.length ? [t`Also applied ${others}.`] : []),
  ].join(" ");
}
