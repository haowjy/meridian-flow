import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { pendingRecords } from "@meridian/project-tree";
import { Folder as FolderIcon, Layers } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useProjectTreeViews, useTreeList } from "@/client/query/useProjectTree";
import { useWorks } from "@/client/query/useWorks";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { DisclosureMark } from "@/components/ui/marks";
import type { TreeEntry } from "@/core/project-tree/tree-view";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
  DraftNoticeLine,
  noticeAction,
  useDraftNotice,
} from "@/features/draft-review/CommandNotice";
import { draftCopyView } from "@/features/draft-review/copy-view";
import {
  DeletedFromManuscriptTag,
  DraftCommandStatus,
} from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import { folderKey } from "@/features/draft-review/draft-command-owner";
import { DiscardQuestion, ReviewActions } from "@/features/draft-review/ReviewActions";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import {
  type ChangeGroup,
  groupByChangedFolder,
  type LandingFault,
  landingFaultSentence,
  landingFaults,
} from "@/features/draft-review/tree-groups";
import { hasTreeLine, reviewHasNoRoom, treeLineOf } from "@/features/draft-review/tree-line";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import type { WorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { escapeCssIdent } from "@/lib/css-selector";
import { useFocusSuccession } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../../context/context-file-icon";
import { EDITOR_CONTEXT_SCHEMES, schemeLabel } from "../../context/context-schemes";
import { useReferenceDrag } from "../../context/entry-drag/reference-source";
import { useAiDraftLauncher } from "../../review-launch";
import { useShellTreeVersion } from "../../tree-version";
import { useScopeDraftOwner, useWorkScope } from "../../use-work-scope";
import { SourcePane } from "./SourcePane";

/**
 * Whose changes the Changes tab lists: the Work picked in the sidebar, or under None the
 * chat on screen's own drafts when it has no Work (the chat Scratch rule).
 */
export type ChangesScope = {
  /** The Work the commands act for: the picked Work, else the chat on screen's (No Work for a chat's own drafts). */
  work: Work | null;
  /** "" when there is nothing to list (None with no chat of its own). */
  ownerKey: string;
  heading: string;
  empty: string;
  /** What waits on the writer: the documents and folders the Work or the chat changes. */
  count: number;
  /** Whether the strip offers the tab; under None only while the chat on screen's drafts wait. */
  offered: boolean;
  /**
   * Another Work with changes to review, when this scope has none: the empty state names it. The
   * sidebar never switches the pick by itself; the chat's Work comes first.
   */
  elsewhere: { work: Work; count: number } | null;
};

export function useChangesScope(projectId: string, chatThreadId: string | null): ChangesScope {
  const { picked, work, ownerKey } = useScopeDraftOwner(projectId, chatThreadId);
  const lineageCount = useOwnerDrafts(projectId, picked ? "" : ownerKey, {
    enabled: !picked,
  }).drafts?.length;
  const { works } = useWorks(projectId);
  const chatWorkId = useDisplayedThread(projectId, chatThreadId)?.workId ?? null;
  // The shell reads the Work's list and its tree: every document and folder it changes, each
  // once, as the rows show them. The Work's own count, from the Works list, counts documents.
  const shell = useShellTreeVersion();
  const changed = shell?.ownerKey === ownerKey && ownerKey ? shell.changed.size : null;
  // SourcesBody's context carries this scope: a new object every render would redraw every pane.
  return useMemo(() => {
    const count = changed ?? (picked ? picked.pendingDocumentCount : (lineageCount ?? 0));
    const others = (works ?? [])
      .filter((other) => other.id !== work?.id && !isWorkArchived(other))
      .filter((other) => other.pendingDocumentCount > 0)
      .sort((a, b) => Number(b.id === chatWorkId) - Number(a.id === chatWorkId));
    const other = count === 0 ? others[0] : undefined;
    const elsewhere = other ? { work: other, count: other.pendingDocumentCount } : null;
    // Under No Work the chat on screen's Work, when it has one, is followed like a pick.
    const named = picked ?? (work && !work.isNoWork ? work : null);
    if (named) {
      const name = named.name;
      return {
        work,
        ownerKey,
        heading: t`Changes in ${name}`,
        empty: t`Nothing to review in ${name}.`,
        count,
        offered: Boolean(picked) || count > 0,
        elsewhere,
      };
    }
    return {
      work,
      ownerKey,
      heading: t`Changes in this chat`,
      empty: t`Nothing to review in this chat.`,
      count,
      offered: Boolean(ownerKey) && count > 0,
      elsewhere,
    };
  }, [picked, work, ownerKey, lineageCount, works, chatWorkId, changed]);
}

/**
 * The scope's drafted documents, one row each in the one file order, under the folders the Work
 * changes. A row opens its draft; its × and ✓ discard or apply that document's draft, and a
 * folder's apply or discard everything under it, the folder's own change included. Discard all
 * and Apply all act on every change of the scope, new documents, folders, moves and deletes
 * included. Each Apply is one command, which sidebar Undo takes back whole, and each Discard's
 * notice has its Undo; only a frozen owner's Discard asks first (`discardAsks`). An Apply of
 * several asks when it would delete documents or bring back documents deleted from the
 * manuscript, naming each, and again for any a newer delete held back. A question takes the
 * place of the buttons that asked it. A Discard made here shows its notice in the row's place
 * (Discard all: the bar's); an Apply's facts sit below the rows.
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
  // Locked with rows to show means archived or deleted: no owner key or Work lists nothing.
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
  const listedFiles = listed.filter((file) => {
    const state = controller.owner.state(file.draft.itemKey);
    // A command in flight hides its row, until its delivery needs the writer's Retry.
    if (state.hidden && !state.stalled) return false;
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
  const tree = useWorkTree(projectId, ownerKey);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const fold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const groups = tree
    ? groupByChangedFolder(listedFiles, tree.work, tree.pending, tree.faults)
    : [{ folder: null, files: listedFiles }];
  // Grouped, the list's order is the groups' order: every index below reads this one.
  const files = groups.flatMap((group) => group.files);
  // Apply needs what it would apply: a new file, a move or delete, or a read draft's changes.
  const applicable = (file: ReviewFileTarget) =>
    (!file.draft.hasDraft && file.draft.isNew) ||
    hasTreeLine(file.draft) ||
    (file.draft.hasDraft && (readOf(file)?.frame?.groups.length ?? 0) > 0);

  /** What an Apply of several asks about first: the documents it deletes and those it brings back. */
  const [asking, setAsking] = useState<{
    targets: readonly ReviewFileTarget[];
    folders: readonly string[];
    name?: string;
    deleting: readonly ReviewFileTarget[];
    restoring: readonly ReviewFileTarget[];
  } | null>(null);
  // The folder changes Apply all takes along: every one that can land.
  const changedFolders = groups.flatMap((group) =>
    group.folder && !group.folder.fault ? group.folder.folders : [],
  );
  // A folder changed alone lists no document, and is still a change to review.
  const hasFiles = files.length > 0 || groups.some((group) => group.folder);
  useEffect(() => {
    if (hasFiles) return;
    setAsking(null);
  }, [hasFiles]);

  const draftsOf = (targets: readonly ReviewFileTarget[]) =>
    targets.map((file) => ({ documentId: file.documentId, itemKey: file.draft.itemKey }));
  const everyDraft = draftsOf(files);
  const ids = (targets: readonly ReviewFileTarget[]) =>
    new Set(targets.map((file) => file.documentId));
  // One command. Brings back only the named documents; a delete the list hadn't shown yet held
  // it back, and it asks again, naming what live deleted.
  const applyAll = (
    targets: readonly ReviewFileTarget[],
    folders: readonly string[],
    restore: ReadonlySet<string>,
    name?: string,
  ) =>
    void controller
      .applyMany(
        draftsOf(targets).map((draft) => ({ draft, target: { kind: "draft" as const } })),
        restore,
        folders,
        name,
      )
      .then((outcomes) => {
        const heldBack = targets.filter(
          (_file, index) => outcomes[index]?.kind === "needs-restore",
        );
        const restoring = targets.filter((_file, index) => {
          const outcome = outcomes[index];
          return outcome?.kind === "needs-restore" && outcome.deleted === true;
        });
        if (heldBack.length > 0)
          setAsking({ targets: heldBack, folders, deleting: [], restoring, name });
      });
  const startApply = (
    targets: readonly ReviewFileTarget[],
    folders: readonly string[],
    name?: string,
  ) => {
    const restoring = targets.filter((file) => isDeletedFromManuscript(file.draft));
    const deleting = targets.filter((file) => file.draft.tree?.deleted === true);
    if (restoring.length > 0 || deleting.length > 0)
      setAsking({ targets, folders, deleting, restoring, name });
    else applyAll(targets, folders, new Set(), name);
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
          applyAll(asking.targets, asking.folders, ids(asking.restoring), asking.name);
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
  // A Discard's focus follows to its notice's Undo; an Undo's, to the row it brings back.
  const undone = useRef<string | null>(null);
  if (rowNotice !== null) undone.current = rowNotice;
  const list = useRef<HTMLDivElement>(null);
  useFocusSuccession(
    list,
    true,
    (element) =>
      noticeAction(element) ??
      (undone.current
        ? element.querySelector<HTMLElement>(
            `[data-change-row="${escapeCssIdent(undone.current)}"] button`,
          )
        : null),
  );

  return (
    <div ref={list} className="contents">
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
              discardAsks={controller.frozen}
              onDiscard={
                everyDraft.length > 0 || changedFolders.length > 0
                  ? () => void controller.discardAll(everyDraft)
                  : undefined
              }
              onApply={
                controller.canApply &&
                files.every(applicable) &&
                (files.length > 0 || changedFolders.length > 0)
                  ? () => startApply(files, changedFolders)
                  : undefined
              }
              applyDisabled={held.some((read) => read.status !== "ready")}
            />
          ) : null
        }
      >
        {hasFiles && (archived || controller.frozen) ? (
          <div className="px-2">
            <ListLine iconSlot>
              {archived && scope.work?.deletedAt ? (
                <Trans>This Work is deleted. Restore it to apply or discard its changes.</Trans>
              ) : archived ? (
                <Trans>This Work is archived. Unarchive it to apply or discard its changes.</Trans>
              ) : (
                <Trans>This chat is in Trash. Restore it to edit or apply its drafts.</Trans>
              )}
            </ListLine>
          </div>
        ) : null}
        {hasFiles ? (
          <ul className="flex flex-col px-2">
            {groups.map((group) => {
              const depth = group.folder ? 1 : 0;
              const head = group.folder ? (
                <FolderGroupRow
                  key={`folder:${group.folder.id}`}
                  branchId={drafts.branchId}
                  folder={group.folder}
                  open={!folded.has(group.folder.id)}
                  onToggle={() => fold(group.folder?.id ?? "")}
                  entry={tree?.entry(group.folder.id) ?? null}
                  files={group.files}
                  controller={controller}
                  touch={touch}
                  canApply={
                    controller.canApply && !group.folder.fault && group.files.every(applicable)
                  }
                  onApply={(name) => startApply(group.files, group.folder?.folders ?? [], name)}
                  onDiscard={(name) =>
                    void controller.discardSelection({
                      drafts: draftsOf(group.files),
                      folders: group.folder?.folders ?? [],
                      name,
                    })
                  }
                />
              ) : null;
              const shown = group.folder && folded.has(group.folder.id) ? [] : group.files;
              return [
                head,
                ...shown.map((file) => {
                  const index = files.indexOf(file);
                  return (
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
                        depth={depth}
                        fault={tree?.faults.get(file.documentId) ?? null}
                        textChanges={
                          readOf(file)?.status === "ready"
                            ? readOf(file)?.listedChanges.length
                            : undefined
                        }
                        active={isOpen(file)}
                        canApply={controller.canApply && applicable(file)}
                        controller={controller}
                        touch={touch}
                        onPicked={onPicked}
                      />
                    </Fragment>
                  );
                }),
              ];
            })}
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
        ) : (
          <div className="px-2">
            {drafts.status === "loading" ? (
              <ListLine iconSlot status>
                <Trans>Loading changes…</Trans>
              </ListLine>
            ) : (
              <>
                <ListLine iconSlot>{scope.empty}</ListLine>
                {scope.elsewhere ? (
                  <ElsewhereLink projectId={projectId} {...scope.elsewhere} />
                ) : null}
              </>
            )}
          </div>
        )}
        {notice && !inList && !inBar ? (
          <div className="mx-2">
            <CommandNotice notice={notice} />
          </div>
        ) : null}
      </SourcePane>
    </div>
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
  depth,
  fault,
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
  /** Under its changed folder's row. */
  depth: number;
  /** Why its tree change cannot land, which stays after Apply as the change stays pending. */
  fault: LandingFault | null;
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
    <li data-change-row={file.documentId}>
      <ListRow
        onOpen={review}
        depth={depth}
        current={active}
        disabled={!opens}
        controlProps={drag}
        icon={fileKindIcon(file.contextLocation?.path ?? name)}
        title={
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("truncate", deleted && "line-through")}>{name}</span>
            <DeletedFromManuscriptTag item={file.draft} />
          </span>
        }
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
            {fault ? (
              <InlineErrorRow message={landingFaultSentence(fault)} className="p-0 text-xs" />
            ) : null}
            <DraftCommandStatus itemKey={file.draft.itemKey} />
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
  const place = file.contextLocation ? folderPlace(file.contextLocation) : null;
  const tree = file.draft.isNew
    ? place
      ? t`New in ${place}`
      : t`New`
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

/** "Manuscript/Arc 3": the source and folder a document lands in. */
function folderPlace(location: NonNullable<ReviewFileTarget["contextLocation"]>): string {
  const folders = location.path.split("/").filter(Boolean).slice(0, -1);
  const source = location.scheme ? schemeLabel(location.scheme) : null;
  return [source, ...folders].filter(Boolean).join("/");
}

/** The Work's view, its pending records and what cannot land, read from the list. */
function useWorkTree(projectId: string, ownerKey: string) {
  const shell = useShellTreeVersion();
  const version = shell?.ownerKey === ownerKey ? shell.draftVersion : null;
  const { session, snapshot } = useTreeList({ kind: "project", projectId });
  const schemes = useMemo(() => [...EDITOR_CONTEXT_SCHEMES], []);
  const trees = useProjectTreeViews(projectId, schemes, {
    enabled: version !== null,
    ...(version ? { version } : {}),
  });
  const docVersion = snapshot?.version;
  return useMemo(() => {
    if (!version || !session || !snapshot || version.view.draft === null) return null;
    const work = session.replay(version.view, version.pendingText);
    const pending = pendingRecords(snapshot.doc, version.view.draft);
    return {
      work,
      pending,
      faults: landingFaults(work, pending),
      entry: (id: string) =>
        Object.values(trees)
          .flatMap(({ tree }) => tree?.entry(id) ?? [])
          .at(0) ?? null,
    };
    // `version` of the copy is what changes the replay.
  }, [version, session, snapshot, docVersion, trees]);
}

/**
 * A folder the Work changes, heading what it holds: its name, what the Work does to it, why it
 * cannot land if it cannot, and × ✓ for it and everything listed under it; a click folds its
 * rows. A folder changed with no drafted document under it takes its × and ✓ alone. Its own
 * command's state (pending, refused, waiting for confirmation) shows under it, as a document's
 * does under its row.
 */
function FolderGroupRow({
  branchId,
  folder,
  entry,
  open,
  onToggle,
  files,
  controller,
  touch,
  canApply,
  onApply,
  onDiscard,
}: {
  folder: NonNullable<ChangeGroup<ReviewFileTarget>["folder"]>;
  entry: TreeEntry | null;
  /** Its rows show; a click folds them. */
  open: boolean;
  onToggle: () => void;
  files: readonly ReviewFileTarget[];
  controller: WorkBranchCommands;
  touch: boolean;
  canApply: boolean;
  /** `name`: the folder's, for what the Apply's Undo and the Discard's notice say. */
  onApply: (name: string) => void;
  onDiscard: (name: string) => void;
  /** The Work's branch, whose folder items hold the folder's command state. */
  branchId: string | null;
}) {
  const keys = branchId ? folder.folders.map((id) => folderKey(branchId, id)) : [];
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  const pending = keys.some((key) => controller.owner.state(key).pending);
  const name = entry?.name ?? t`Folder`;
  const { change } = folder;
  const was = change.kind === "changed" ? change.was : null;
  const moved = change.kind === "changed" ? change.moved : null;
  const into = moved && moved !== "top" ? moved.into : null;
  const movedLine = moved === "top" ? t`Moving to the top` : into ? t`Moving into ${into}` : null;
  const detail =
    change.kind === "new"
      ? t`New`
      : change.kind === "deleted"
        ? t`Deleted`
        : [was ? t`Was ${was}` : null, movedLine].filter(Boolean).join(". ");
  return (
    <li data-change-folder={folder.id}>
      <ListRow
        icon={FolderIcon}
        onOpen={onToggle}
        controlProps={files.length > 0 ? { "aria-expanded": open } : undefined}
        trailing={files.length > 0 ? <DisclosureMark open={open} /> : undefined}
        title={
          <span className={cn("truncate", change.kind === "deleted" && "line-through")}>
            {name}
          </span>
        }
        detail={detail}
        actions={
          <ReviewActions
            scope="document"
            labels={{
              apply: t`Apply changes in ${name}`,
              discard: t`Discard changes in ${name}`,
            }}
            density="icon"
            touch={touch}
            disabled={pending || controller.dispositionLocked}
            className={touch ? "gap-0" : "gap-0.5"}
            onDiscard={() => onDiscard(name)}
            onApply={canApply ? () => onApply(name) : undefined}
          />
        }
        below={
          <div className="pl-1">
            {folder.fault ? (
              <InlineErrorRow
                message={landingFaultSentence(folder.fault)}
                className="p-0 text-xs"
              />
            ) : null}
            {keys.map((key) => (
              <DraftCommandStatus key={key} itemKey={key} />
            ))}
          </div>
        }
      />
    </li>
  );
}

/** Another Work with changes, named with its count: picking it switches the sidebar to it. */
function ElsewhereLink({
  projectId,
  work,
  count,
}: {
  projectId: string;
  work: Work;
  count: number;
}) {
  const { setWorkId } = useWorkScope(projectId);
  return (
    <ListRow
      icon={Layers}
      onOpen={() => setWorkId(work.id)}
      title={work.name}
      detail={<Plural value={count} one="# document to review" other="# documents to review" />}
    />
  );
}
