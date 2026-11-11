import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ListRow } from "@/components/ui/list-row";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
  DraftNoticeLine,
  useDraftNotice,
} from "@/features/draft-review/CommandNotice";
import { draftCopyView } from "@/features/draft-review/copy-view";
import { DraftCommandStatus } from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import { DiscardQuestion, ReviewActions } from "@/features/draft-review/ReviewActions";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { hasTreeLine, reviewHasNoRoom, treeLineOf } from "@/features/draft-review/tree-line";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import type { WorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { RowIcon } from "../../context/ContextTreeRows";
import { fileKindIcon } from "../../context/context-file-icon";
import { useReferenceDrag } from "../../context/entry-drag/reference-source";
import { useAiDraftLauncher } from "../../review-launch";
import { useScopeDraftOwner } from "../../use-work-scope";
import { SourceHint, SourcePane } from "./SourcePane";

/**
 * Whose changes the Changes tab lists: the Work picked in the sidebar, or under None the
 * chat on screen's own drafts when it has no Work (the chat Scratch rule).
 */
export type ChangesScope = {
  /** The Work the commands act for: the picked Work, or No Work for a chat's lineage. */
  work: Work | null;
  /** "" when there is nothing to list (None with no chat of its own). */
  ownerKey: string;
  heading: string;
  empty: string;
  /** What waits on the writer: the picker's count for a Work, the listed drafts for a chat. */
  count: number;
  /** Whether the strip offers the tab; under None only a chat with drafts does. */
  offered: boolean;
};

export function useChangesScope(projectId: string, chatThreadId: string | null): ChangesScope {
  const { picked, work, ownerKey } = useScopeDraftOwner(projectId, chatThreadId);
  const lineageCount = useOwnerDrafts(projectId, picked ? "" : ownerKey, {
    enabled: !picked,
  }).drafts?.length;
  // SourcesBody's context carries this scope: a new object every render would redraw every pane.
  return useMemo(() => {
    if (picked) {
      const name = picked.name;
      return {
        work,
        ownerKey,
        heading: t`Changes in ${name}`,
        empty: t`Nothing to review in ${name}.`,
        count: picked.pendingDocumentCount,
        offered: true,
      };
    }
    const count = lineageCount ?? 0;
    return {
      work,
      ownerKey,
      heading: t`Changes in this chat`,
      empty: t`Nothing to review in this chat.`,
      count,
      offered: Boolean(ownerKey) && count > 0,
    };
  }, [picked, work, ownerKey, lineageCount]);
}

/**
 * The scope's drafted documents, one row each in the one file order. A row opens its draft;
 * its × and ✓ discard or apply that document's draft. Discard all and Apply all act on every
 * draft of the scope, new documents, moves and deletes included. A Discard asks first only when
 * it can't run here and so carries no Undo (`discardAsks`); an Apply all asks when it would
 * delete documents or bring back documents deleted from the manuscript, naming each, and again
 * for any a newer delete held back. A question takes the place of the buttons that asked it. A Discard made here shows its
 * notice in the row's place (Discard all: the bar's); an Apply's facts sit below the rows.
 *
 * An archived Work's commands show disabled, with the reason above the rows. A frozen lineage
 * (every chat in Trash) offers no Apply, only Discard.
 */
export function ChangesSource({
  projectId,
  scope,
  controller,
  isOpen,
  onPicked,
}: {
  projectId: string;
  scope: ChangesScope;
  /** The scope's commands, held by the sidebar so their notice outlives this pane. */
  controller: WorkBranchCommands;
  /** Whether the file is the document open in the editor. */
  isOpen: (file: ReviewFileTarget) => boolean;
  onPicked?: () => void;
}) {
  const { ownerKey } = scope;
  // Locked with rows to show means archived: no owner key or Work lists nothing.
  const archived = controller.dispositionLocked;
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  const touch = useCoarsePointer();
  const drafts = useOwnerDrafts(projectId, ownerKey);
  const listed = drafts.files ?? [];
  const textRows = listed.filter((file) => file.draft.hasDraft);
  const held = useRoomReviews(
    textRows.map((file) => ({
      projectId,
      ownerKey,
      documentId: file.documentId,
      itemKey: file.draft.itemKey,
    })),
  );
  const readOf = (file: ReviewFileTarget) =>
    held[textRows.findIndex((row) => row.draft.itemKey === file.draft.itemKey)];
  const files = listed.filter((file) => {
    const state = controller.owner.state(file.draft.itemKey);
    if (state.hidden) return false;
    const read = readOf(file);
    return (
      file.draft.wholeItem ||
      hasTreeLine(file.draft) ||
      read?.status !== "ready" ||
      read.listedChanges.length > 0 ||
      state.pending ||
      state.failure
    );
  });
  // Apply needs what it would apply: a new file, a move or delete, or a read draft's changes.
  const applicable = (file: ReviewFileTarget) =>
    (!file.draft.hasDraft && file.draft.isNew) ||
    hasTreeLine(file.draft) ||
    (file.draft.hasDraft && (readOf(file)?.frame?.groups.length ?? 0) > 0);

  /** What an Apply all asks about first: the documents it deletes and those it brings back. */
  const [asking, setAsking] = useState<{
    deleting: readonly ReviewFileTarget[];
    restoring: readonly ReviewFileTarget[];
  } | null>(null);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (hasFiles) return;
    setAsking(null);
  }, [hasFiles]);

  const everyDraft = files.map((file) => ({
    documentId: file.documentId,
    itemKey: file.draft.itemKey,
  }));
  const ids = (targets: readonly ReviewFileTarget[]) =>
    new Set(targets.map((file) => file.documentId));
  // Brings back only the named documents; a delete the list hadn't shown yet asks again.
  const applyAll = (restore: ReadonlySet<string>) =>
    void controller.disposeDrafts("apply", everyDraft, restore).then((outcomes) => {
      const heldBack = files.filter((_file, index) => outcomes[index]?.kind === "needs-restore");
      if (heldBack.length > 0) setAsking({ deleting: [], restoring: heldBack });
    });
  const startApplyAll = () => {
    const restoring = files.filter((file) => isDeletedFromManuscript(file.draft));
    const deleting = files.filter((file) => file.draft.tree?.deleted === true);
    if (restoring.length > 0 || deleting.length > 0) setAsking({ deleting, restoring });
    else applyAll(new Set());
  };
  const untitled = t`Untitled document`;
  const names = (targets: readonly ReviewFileTarget[]) =>
    targets.map((file) => reviewFileTargetName(file, untitled));
  const question: CommandQuestion | null = asking
    ? {
        kind: "apply-all",
        sentence: (
          <ApplyAllQuestion deleting={names(asking.deleting)} restoring={names(asking.restoring)} />
        ),
        keep: <Trans>Cancel</Trans>,
        confirm: <Trans>Apply all</Trans>,
        onKeep: () => setAsking(null),
        onConfirm: () => {
          setAsking(null);
          applyAll(ids(asking.restoring));
        },
        disabled: controller.dispositionLocked,
      }
    : null;
  const owned = useDraftNotice(ownerKey);
  const notice = owned?.surface.kind === "changes" ? owned : null;
  // A single draft's Discard takes the place its row had, after the list's next read drops it.
  const rowAt = useRef(new Map<string, number>());
  files.forEach((file, index) => {
    rowAt.current.set(file.documentId, index);
  });
  const rowNotice =
    notice?.kind === "discarded" && notice.subject.kind !== "drafts" ? notice.documentIds[0] : null;
  const noticeAt =
    rowNotice !== null && hasFiles && !files.some((file) => file.documentId === rowNotice)
      ? rowAt.current.get(rowNotice)
      : undefined;
  const inList = noticeAt !== undefined;
  const inBar = notice !== null && !inList && !question && !hasFiles;

  return (
    <SourcePane
      label={scope.heading}
      bar={
        question ? (
          <div className="min-w-0 flex-1">
            <CommandNotice notice={null} question={question} />
          </div>
        ) : inBar && notice ? (
          <DraftNoticeLine notice={notice} className="min-w-0 flex-1" />
        ) : hasFiles ? (
          <ReviewActions
            scope="all"
            density="full"
            touch={touch}
            disabled={archived}
            discardAsks={controller.discardAllAsks(everyDraft)}
            onDiscard={() => void controller.disposeDrafts("discard", everyDraft)}
            onApply={controller.canApply && files.every(applicable) ? startApplyAll : undefined}
            applyDisabled={held.some((read) => read.status !== "ready")}
          />
        ) : null
      }
    >
      {hasFiles && archived ? (
        <SourceHint>
          <Trans>This Work is archived. Unarchive it to apply or discard its changes.</Trans>
        </SourceHint>
      ) : hasFiles && controller.frozen ? (
        <SourceHint>
          <Trans>This chat is in Trash. Restore it to edit or apply its drafts.</Trans>
        </SourceHint>
      ) : null}
      {hasFiles ? (
        <ul className="flex flex-col px-2">
          {files.map((file, index) => (
            <Fragment key={file.documentId}>
              {inList && notice && index === noticeAt ? (
                <li>
                  <DraftNoticeLine notice={notice} />
                </li>
              ) : null}
              <ChangeRow
                projectId={projectId}
                ownerKey={ownerKey}
                file={file}
                textChanges={
                  readOf(file)?.status === "ready" ? readOf(file)?.listedChanges.length : undefined
                }
                active={isOpen(file)}
                canApply={controller.canApply && applicable(file)}
                controller={controller}
                touch={touch}
                onPicked={onPicked}
              />
            </Fragment>
          ))}
          {inList && notice && noticeAt !== undefined && noticeAt >= files.length ? (
            <li>
              <DraftNoticeLine notice={notice} />
            </li>
          ) : null}
        </ul>
      ) : drafts.status === "error" ? (
        <InlineErrorRow
          message={t`Changes couldn’t load.`}
          onRetry={drafts.refetch}
          actionLabel={t`Retry changes`}
        />
      ) : drafts.status === "loading" ? (
        <SourceHint status>
          <Trans>Loading changes…</Trans>
        </SourceHint>
      ) : (
        <SourceHint>{scope.empty}</SourceHint>
      )}
      {notice && !inList && !inBar ? (
        <div className="mx-2">
          <CommandNotice notice={notice} />
        </div>
      ) : null}
    </SourcePane>
  );
}

/**
 * One drafted document: its name, and under it what the draft does to it (a move, rename or
 * delete, a new document, its text changes). Its × and ✓ show on hover or focus, always with a
 * finger. A refused or pending command shows in the status line under it.
 */
function ChangeRow({
  projectId,
  ownerKey,
  file,
  textChanges,
  active,
  canApply,
  controller,
  touch,
  onPicked,
}: {
  projectId: string;
  ownerKey: string;
  file: ReviewFileTarget;
  /** The draft's text changes once its room is read. */
  textChanges: number | undefined;
  active: boolean;
  canApply: boolean;
  controller: WorkBranchCommands;
  touch: boolean;
  onPicked?: () => void;
}) {
  const { openReviewFile } = useAiDraftLauncher();
  const [previewing, setPreviewing] = useState(false);
  // A row's actions are too narrow for its question: it asks on the line under the name.
  const [asking, setAsking] = useState(false);
  const draft = { documentId: file.documentId, itemKey: file.draft.itemKey };
  const discard = () => void controller.discard(file.documentId, file.draft.itemKey);
  const name = file.documentName || file.contextLocation?.path || t`Untitled document`;
  const copyView = draftCopyView(file, ownerKey);
  const drag = useReferenceDrag(
    copyView ? { ref: { kind: "file", id: file.documentId }, name, view: copyView } : null,
  );
  const treeOnly = reviewHasNoRoom(file.draft);
  const imageOpenable = file.draft.binary;
  const opens = Boolean(file.contextLocation) && (file.draft.hasDraft || treeOnly || imageOpenable);
  const review = () => {
    if (file.draft.hasDraft || treeOnly) {
      openReviewFile(file, ownerKey);
      onPicked?.();
    } else if (imageOpenable) setPreviewing(true);
  };
  const line = treeLineOf(file.draft);
  const deleted = line?.kind === "delete";
  const command = controller.owner.state(file.draft.itemKey);

  return (
    <li>
      <ListRow
        onOpen={review}
        current={active}
        disabled={!opens}
        controlProps={drag}
        leading={<RowIcon icon={fileKindIcon(file.contextLocation?.path ?? name)} />}
        title={<span className={cn(deleted && "line-through")}>{name}</span>}
        detail={changeSummary(file, textChanges)}
        revealActions={!touch}
        actions={
          <ReviewActions
            scope="document"
            labels={{ apply: t`Apply draft of ${name}`, discard: t`Discard draft of ${name}` }}
            density="icon"
            touch={touch}
            disabled={command.pending || controller.dispositionLocked}
            className={touch ? "gap-0" : "gap-0.5"}
            onDiscard={() => (controller.discardAsks(draft) ? setAsking(true) : discard())}
            onApply={
              canApply
                ? () => void controller.apply(file.documentId, file.draft.itemKey)
                : undefined
            }
          />
        }
        below={
          <div className="pl-1">
            {asking && !controller.dispositionLocked ? (
              <DiscardQuestion
                scope="document"
                onKeep={() => setAsking(false)}
                onConfirm={() => {
                  setAsking(false);
                  discard();
                }}
              />
            ) : null}
            <DraftCommandStatus itemKey={file.draft.itemKey} item={file.draft} />
          </div>
        }
      />
      <DraftImagePreview
        target={previewing ? { projectId, ownerKey, documentId: file.documentId, name } : null}
        onClose={() => setPreviewing(false)}
      />
    </li>
  );
}

/**
 * What the draft does to the document, in a quiet line under its name; nothing to say, no line.
 * The row's name is already the draft's, so a rename says what it was.
 */
function changeSummary(file: ReviewFileTarget, textChanges: number | undefined) {
  const line = treeLineOf(file.draft);
  const tree = file.draft.isNew
    ? t`New`
    : line?.kind === "delete"
      ? t`Deleted`
      : line?.kind === "rename"
        ? t`Was ${line.name}`
        : line?.kind === "move"
          ? t`Moving to ${line.place}`
          : line?.kind === "reorder"
            ? t`Changing position`
            : null;
  // A new or deleted document is the whole change: its text needs no count.
  const count = !file.draft.isNew && line?.kind !== "delete" && textChanges ? textChanges : null;
  if (!tree && count === null) return null;
  return (
    <span className="flex min-w-0 gap-2">
      {tree ? <span className="min-w-0 truncate">{tree}</span> : null}
      {count !== null ? (
        <span className="shrink-0">
          <Plural value={count} one="# text change" other="# text changes" />
        </span>
      ) : null}
    </span>
  );
}
