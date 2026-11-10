import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { role } from "@/components/ui/roles";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
} from "@/features/draft-review/CommandNotice";
import { draftCopyView } from "@/features/draft-review/copy-view";
import { DraftCommandStatus } from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import { chatOwnerKey, workOwnerKey } from "@/features/draft-review/draft-owner-key";
import { ReviewActions } from "@/features/draft-review/ReviewActions";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { hasTreeLine, reviewHasNoRoom, treeLineOf } from "@/features/draft-review/tree-line";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import {
  useWorkBranchCommands,
  type WorkBranchCommands,
} from "@/features/draft-review/useWorkBranchCommands";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { contextTreeFileRowClassName } from "../../context/context-row-geometry";
import { useReferenceDrag } from "../../context/entry-drag/reference-source";
import { useAiDraftLauncher } from "../../review-launch";
import { useWorkScope } from "../../use-work-scope";
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
  const { workId } = useWorkScope(projectId);
  const { works, noWork } = useWorks(projectId);
  const thread = useDisplayedThread(projectId, chatThreadId);
  const snapshot = noWork ? { works: works ?? [], noWork } : null;
  const picked = workId && workId !== noWork?.id ? workFromSnapshot(snapshot, workId) : null;
  const chatWork = thread?.workId ? workFromSnapshot(snapshot, thread.workId) : null;
  // A chat on a named Work has no drafts of its own under None: its Work holds them.
  const lineageKey =
    !picked && chatWork?.isNoWork ? chatOwnerKey(chatWork, thread?.rootThreadId ?? null) : "";
  const lineageDrafts = useOwnerDrafts(projectId, lineageKey, { enabled: !picked });
  if (picked) {
    const name = picked.name;
    return {
      work: picked,
      ownerKey: workOwnerKey(picked),
      heading: t`Changes in ${name}`,
      empty: t`Nothing to review in ${name}.`,
      count: picked.pendingDocumentCount,
      offered: true,
    };
  }
  const count = lineageDrafts.drafts?.length ?? 0;
  return {
    work: lineageKey ? chatWork : null,
    ownerKey: lineageKey,
    heading: t`Changes in this chat`,
    empty: t`Nothing to review in this chat.`,
    count,
    offered: Boolean(lineageKey) && count > 0,
  };
}

/**
 * The scope's drafted documents, one row each in the one file order. A row opens its draft;
 * its × and ✓ discard or apply that document's draft. Discard all and Apply all act on every
 * draft of the scope, new documents, moves and deletes included. Discard all asks first, and so
 * does an Apply all that would delete documents or bring back documents deleted from the
 * manuscript, naming each, and again for any a newer delete held back. A question takes the
 * place of the buttons that asked it; the latest command's notice sits below the rows.
 */
export function ChangesSource({
  projectId,
  scope,
  isOpen,
  onPicked,
}: {
  projectId: string;
  scope: ChangesScope;
  /** Whether the file is the document open in the editor. */
  isOpen: (file: ReviewFileTarget) => boolean;
  onPicked?: () => void;
}) {
  const { work, ownerKey } = scope;
  const controller = useWorkBranchCommands({ projectId, work, ownerKey });
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

  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** What an Apply all asks about first: the documents it deletes and those it brings back. */
  const [asking, setAsking] = useState<{
    deleting: readonly ReviewFileTarget[];
    restoring: readonly ReviewFileTarget[];
  } | null>(null);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (hasFiles) return;
    setConfirmingDiscard(false);
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
    : confirmingDiscard
      ? {
          kind: "discard",
          sentence: work?.isNoWork ? (
            <Trans>Discard this chat's changes?</Trans>
          ) : (
            <>
              <Trans>Discard all changes?</Trans>{" "}
              <Trans>This removes pending changes from every document in this Work.</Trans>
            </>
          ),
          keep: <Trans>Keep</Trans>,
          confirm: <Trans>Discard</Trans>,
          onKeep: () => setConfirmingDiscard(false),
          onConfirm: () => {
            setConfirmingDiscard(false);
            void controller.disposeDrafts("discard", everyDraft);
          },
          disabled: controller.dispositionLocked,
        }
      : null;

  return (
    <SourcePane
      label={scope.heading}
      bar={
        question ? (
          <div className="min-w-0 flex-1">
            <CommandNotice commands={{ notice: null, undoNotice: () => {} }} question={question} />
          </div>
        ) : hasFiles && !controller.dispositionLocked ? (
          <ReviewActions
            scope="all"
            density="full"
            touch={touch}
            onDiscard={() => setConfirmingDiscard(true)}
            onApply={files.every(applicable) ? startApplyAll : undefined}
            applyDisabled={held.some((read) => read.status !== "ready")}
          />
        ) : null
      }
    >
      {hasFiles ? (
        <ul className="flex flex-col">
          {files.map((file) => (
            <ChangeRow
              key={file.documentId}
              projectId={projectId}
              ownerKey={ownerKey}
              file={file}
              textChanges={
                readOf(file)?.status === "ready" ? readOf(file)?.listedChanges.length : undefined
              }
              active={isOpen(file)}
              canApply={applicable(file)}
              controller={controller}
              touch={touch}
              onPicked={onPicked}
            />
          ))}
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
      <div className="mx-2">
        <CommandNotice commands={controller} />
      </div>
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
  const name = file.documentName || file.contextLocation?.path || t`Untitled document`;
  const copyView = draftCopyView(file, ownerKey);
  const drag = useReferenceDrag(
    copyView ? { ref: { kind: "file", id: file.documentId }, name, view: copyView } : null,
  );
  const treeOnly = reviewHasNoRoom(file.draft);
  const imageOpenable = file.draft.binary;
  const opens = Boolean(file.contextLocation) && (file.draft.hasDraft || treeOnly || imageOpenable);
  const review = () => {
    controller.dismissNotice();
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
      <div
        className={cn(
          contextTreeFileRowClassName(active),
          "gap-1 py-0.5 pl-1",
          !opens && "text-muted-foreground",
        )}
      >
        <button
          type="button"
          {...drag}
          aria-current={active ? "true" : undefined}
          disabled={!opens}
          onClick={review}
          className="focus-ring flex min-w-0 flex-1 flex-col items-start justify-center rounded-sm px-1.5 py-0.5 text-left coarse:min-h-11"
        >
          <span className={cn("w-full truncate", deleted && "line-through")}>{name}</span>
          <ChangeSummary file={file} textChanges={textChanges} />
        </button>
        {controller.dispositionLocked ? null : (
          <ReviewActions
            scope="document"
            density="icon"
            touch={touch}
            disabled={command.pending}
            className={cn(
              "gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100",
              touch && "gap-0 opacity-100",
            )}
            onDiscard={() => void controller.discard(file.documentId, file.draft.itemKey)}
            onApply={
              canApply
                ? () => void controller.apply(file.documentId, file.draft.itemKey)
                : undefined
            }
          />
        )}
      </div>
      <div className="mx-2 pl-1">
        <DraftCommandStatus itemKey={file.draft.itemKey} item={file.draft} />
      </div>
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
function ChangeSummary({
  file,
  textChanges,
}: {
  file: ReviewFileTarget;
  textChanges: number | undefined;
}) {
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
    <span className={cn("flex w-full min-w-0 gap-2", role.rowSecondary)}>
      {tree ? <span className="min-w-0 truncate">{tree}</span> : null}
      {count !== null ? (
        <span className="shrink-0">
          <Plural value={count} one="# text change" other="# text changes" />
        </span>
      ) : null}
    </span>
  );
}
