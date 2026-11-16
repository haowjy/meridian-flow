import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import type { LandingFault } from "@meridian/project-tree";
import { Folder as FolderIcon, Layers } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { useWorks } from "@/client/query/useWorks";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { type GoneRow, withGone } from "@/components/app/RowWord";
import { WorkName } from "@/components/app/WorkName";
import { contentInset, ICON_SLOT_PX, ListLine, ListRow } from "@/components/ui/list-row";
import { DisclosureMark } from "@/components/ui/marks";
import { AgentFileSave } from "@/features/agents/PackageSave";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
  noticeAction,
  useDraftNotice,
  useDraftNoticeWords,
} from "@/features/draft-review/CommandNotice";
import { draftCopyView } from "@/features/draft-review/copy-view";
import {
  DeletedFromManuscriptTag,
  DraftCommandStatus,
} from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import { folderKey } from "@/features/draft-review/draft-command-owner";
import { ReviewActions } from "@/features/draft-review/ReviewActions";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import {
  type ChangeGroup,
  groupByChangedFolder,
  groupFiles,
  groupsOf,
  landingFaultSentence,
} from "@/features/draft-review/tree-groups";
import { hasTreeLine, reviewHasNoRoom, treeLineOf } from "@/features/draft-review/tree-line";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import type { WorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { escapeCssIdent } from "@/lib/css-selector";
import { useFocusSuccession } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../../context/context-file-icon";
import { schemeLabel } from "../../context/context-schemes";
import { useReferenceDrag } from "../../context/entry-drag/reference-source";
import { useOpenProjectDocument } from "../../context/open-project-document";
import { type NoticePlace, useTreeNoticeWords } from "../../context/use-tree-notice-words";
import { useAiDraftLauncher } from "../../review-launch";
import { reviewCount, useShellTreeVersion } from "../../tree-version";
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
  const { works, nameOf } = useWorks(projectId);
  const chatWorkId = useDisplayedThread(projectId, chatThreadId)?.workId ?? null;
  // The shell's count is the Changes list's: the Work's changed documents and folders, from its
  // open list. The Works list's stored count is the same count for a Work whose list is not open.
  const shell = useShellTreeVersion();
  const changed = shell?.ownerKey === ownerKey && ownerKey ? shell.changeCount : null;
  // SourcesBody's context carries this scope: a new object every render would redraw every pane.
  return useMemo(() => {
    const count = picked ? reviewCount(shell, picked) : (changed ?? lineageCount ?? 0);
    const others = (works ?? [])
      .filter((other) => other.id !== work?.id && !isWorkArchived(other))
      .filter((other) => reviewCount(shell, other) > 0)
      .sort((a, b) => Number(b.id === chatWorkId) - Number(a.id === chatWorkId));
    const other = count === 0 ? others[0] : undefined;
    const elsewhere = other ? { work: other, count: reviewCount(shell, other) } : null;
    // Under No Work the chat on screen's Work, when it has one, is followed like a pick.
    const named = picked ?? (work && !work.isNoWork ? work : null);
    if (named) {
      const name = nameOf(named);
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
  }, [picked, work, ownerKey, lineageCount, works, nameOf, chatWorkId, changed, shell]);
}

/**
 * The scope's drafted documents, one row each in the one file order, under the folders the Work
 * changes. A row opens its draft; its × and ✓ discard or apply that document's draft, and a
 * folder's apply or discard everything under it, the folder's own change included. Discard all
 * and Apply all act on every change of the scope, new documents, folders, moves and deletes
 * included. Each Apply is one command, which sidebar Undo takes back whole, and each Discard's
 * notice has its Undo. An Apply of
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
  const shell = useShellTreeVersion();
  const tree = shell?.ownerKey === ownerKey ? shell.tree : null;
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const fold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const groups = tree
    ? groupByChangedFolder(listedFiles, tree)
    : [{ folder: null, files: listedFiles, inner: [] }];
  // Grouped, the list's order is the groups' order: every index below reads this one.
  const files = groups.flatMap(groupFiles);
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
  const changedFolders = groupsOf(groups).flatMap((group) =>
    group.folder && !group.folder.fault ? [group.folder.id] : [],
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
  ) => {
    hold();
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
  };
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
  const words = useDraftNoticeWords(notice);
  const openDocument = useOpenProjectDocument(projectId);
  // What undoing an Apply skipped or couldn't take back is said on the rows it concerns here too.
  const drawn = useMemo<NoticePlace>(() => {
    const folderOf = new Map<string, string | null>();
    const walk = (group: ChangeGroup<ReviewFileTarget>, parent: string | null) => {
      const here = group.folder?.id ?? null;
      if (here) folderOf.set(here, parent);
      for (const file of group.files) folderOf.set(file.documentId, here);
      for (const inner of group.inner) walk(inner, here);
    };
    for (const group of groups) walk(group, null);
    // A row the Apply took stays drawn while a word speaks for it, so what undoing the Apply
    // skipped or left (an edit made since) has a row to show on.
    for (const { key } of taken.get(ownerKey) ?? [])
      if (!folderOf.has(key)) folderOf.set(key, null);
    return {
      holds: (node) => folderOf.has(node),
      parent: (node) => folderOf.get(node) ?? null,
      open: (folder) => !folded.has(folder),
    };
  }, [groups, folded, ownerKey]);
  const treeWords = useTreeNoticeWords(projectId, drawn);
  const wordOf = (key: string) => words.word(key) ?? treeWords.word(key);
  // One list of the rows as shown: a folder heads its documents, then the folders inside it.
  const itemsOf = (group: ChangeGroup<ReviewFileTarget>, depth: number): ChangeItem[] => [
    ...(group.folder
      ? [
          {
            key: group.folder.id,
            kind: "folder" as const,
            group,
            name: group.folder.name,
            detail: folderSummary(group.folder),
            depth,
          },
        ]
      : []),
    ...(group.folder && folded.has(group.folder.id)
      ? []
      : [
          ...group.files.map((file) => ({
            key: file.documentId,
            kind: "file" as const,
            file,
            name: file.documentName || file.contextLocation?.path || t`Untitled document`,
            detail: changeSummary(
              file,
              readOf(file)?.status === "ready" ? readOf(file)?.listedChanges.length : undefined,
            ),
            depth: group.folder ? depth + 1 : 0,
          })),
          ...group.inner.flatMap((inner) => itemsOf(inner, depth + 1)),
        ]),
  ];
  const items: ChangeItem[] = groups.flatMap((group) => itemsOf(group, 0));
  // A Discard or an Apply holds the list as the writer saw it: a row it took stays in its place,
  // saying so, while the notice speaks for it.
  const hold = () => {
    const keys = items.map(changeKey);
    taken.set(
      ownerKey,
      items.map((item, at) => ({ key: item.key, row: item, after: keys.slice(0, at).reverse() })),
    );
  };
  const shown = withGone(
    items,
    changeKey,
    (taken.get(ownerKey) ?? []).filter((row) => words.held(row.key) || treeWords.word(row.key)),
  );
  const goneRows = shown.some((item) => item.gone);
  // A Discard's focus follows to its notice's Undo; an Undo's, to the row it brings back.
  const undone = useRef<string | null>(null);
  if (notice?.kind === "discarded" && notice.documentIds[0]) undone.current = notice.documentIds[0];
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
        notice={treeWords.header}
        bar={
          question ? (
            <div className="min-w-0 flex-1">
              <CommandNotice notice={null} question={question} />
            </div>
          ) : hasFiles ? (
            <ReviewActions
              scope="all"
              density="full"
              touch={touch}
              disabled={archived}
              onDiscard={
                everyDraft.length > 0 || changedFolders.length > 0
                  ? () => {
                      hold();
                      void controller.discardAll(
                        everyDraft,
                        changedFolders,
                        // A lone folder change names itself in the notice.
                        everyDraft.length === 0 && changedFolders.length === 1
                          ? (groupsOf(groups).find(
                              (group) => group.folder?.id === changedFolders[0],
                            )?.folder?.name ?? null)
                          : null,
                      );
                    }
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
          ) : goneRows ? (
            // The rows a command took still show: the bar stays, greyed, so they don't move.
            <ReviewActions
              scope="all"
              density="full"
              touch={touch}
              disabled
              onDiscard={NOTHING}
              onApply={NOTHING}
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
        {hasFiles || goneRows ? (
          <ul className="flex flex-col px-2">
            {shown.map(({ row: item, gone }) => {
              // A row a Discard took is struck through with its Undo; one an Apply took says
              // what the Apply did, and opens the document where it is now.
              if (gone)
                return (
                  <li key={item.key} data-change-row={item.key} data-command-notice="row">
                    <ListRow
                      depth={item.depth}
                      gone={notice?.kind === "discarded"}
                      disabled={item.kind !== "file"}
                      onOpen={() => void openDocument({ documentId: item.key })}
                      icon={
                        item.kind === "file"
                          ? fileKindIcon(item.file.contextLocation?.path ?? item.name)
                          : FolderIcon
                      }
                      title={item.name}
                      detail={item.detail}
                      notice={wordOf(item.key)}
                      below={
                        notice?.kind === "applied" &&
                        item.kind === "file" &&
                        item.file.contextLocation ? (
                          <div
                            className="flex pb-1 empty:hidden"
                            style={{ paddingLeft: contentInset(item.depth) + ICON_SLOT_PX }}
                          >
                            <AgentFileSave
                              projectId={projectId}
                              scheme={item.file.contextLocation.scheme}
                              path={item.file.contextLocation.path}
                            />
                          </div>
                        ) : null
                      }
                    />
                  </li>
                );
              if (item.kind === "folder") {
                const { group } = item;
                const folder = item.group.folder;
                if (!folder) return null;
                const own = groupFiles(group);
                return (
                  <FolderGroupRow
                    key={`folder:${folder.id}`}
                    branchId={drafts.branchId}
                    folder={folder}
                    depth={item.depth}
                    open={!folded.has(folder.id)}
                    onToggle={() => fold(folder.id)}
                    files={own}
                    controller={controller}
                    touch={touch}
                    notice={wordOf(folder.id)}
                    canApply={controller.canApply && !folder.fault && own.every(applicable)}
                    onApply={(name) => startApply(own, folder.folders, name)}
                    onDiscard={(name) => {
                      hold();
                      void controller.discardSelection({
                        drafts: draftsOf(own),
                        folders: folder.folders,
                        name,
                      });
                    }}
                  />
                );
              }
              const { file } = item;
              return (
                <ChangeRow
                  key={file.documentId}
                  projectId={projectId}
                  ownerKey={ownerKey}
                  file={file}
                  depth={item.depth}
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
                  notice={wordOf(file.documentId)}
                  onCommand={hold}
                  onPicked={onPicked}
                />
              );
            })}
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
      </SourcePane>
    </div>
  );
}

type ChangeItem = { key: string; name: string; detail: ReactNode } & (
  | { kind: "folder"; group: ChangeGroup<ReviewFileTarget>; depth: number }
  | { kind: "file"; file: ReviewFileTarget; depth: number }
);

const changeKey = (item: ChangeItem) => item.key;

/** Each owner's list as its latest Discard or Apply found it; its notice says which rows to keep. */
const taken = new Map<string, readonly GoneRow<ChangeItem>[]>();

const NOTHING = () => {};

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
  notice,
  onCommand,
  onPicked,
}: {
  projectId: string;
  ownerKey: string;
  file: ReviewFileTarget;
  /** Right before this row's Discard or Apply: the list holds what it shows. */
  onCommand: () => void;
  /** What the owner's notice says on this row (`useDraftNoticeWords`). */
  notice: ReactNode;
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
  const discard = () => {
    onCommand();
    void controller.discard(file.documentId, file.draft.itemKey);
  };
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
        title={<span className={cn("truncate", deleted && "line-through")}>{name}</span>}
        detail={changeSummary(file, textChanges)}
        notice={notice ?? <DeletedFromManuscriptTag item={file.draft} />}
        revealActions={!touch}
        actions={
          <ReviewActions
            scope="document"
            labels={{ apply: t`Apply draft of ${name}`, discard: t`Discard draft of ${name}` }}
            density="icon"
            touch={touch}
            disabled={command.pending || controller.dispositionLocked}
            className={touch ? "gap-0" : "gap-0.5"}
            onDiscard={discard}
            onApply={
              canApply
                ? () => {
                    onCommand();
                    void controller.apply(file.documentId, file.draft.itemKey);
                  }
                : undefined
            }
          />
        }
        below={
          <div className="pl-1">
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
  depth,
  open,
  onToggle,
  files,
  controller,
  touch,
  canApply,
  onApply,
  onDiscard,
  notice,
}: {
  /** What the owner's notice says on this row. */
  notice: ReactNode;
  folder: NonNullable<ChangeGroup<ReviewFileTarget>["folder"]>;
  /** Under its changed folder's row. */
  depth: number;
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
  const { name, change } = folder;
  return (
    <li data-change-folder={folder.id}>
      <ListRow
        icon={FolderIcon}
        depth={depth}
        onOpen={onToggle}
        controlProps={files.length > 0 ? { "aria-expanded": open } : undefined}
        trailing={files.length > 0 ? <DisclosureMark open={open} /> : undefined}
        title={
          <span className={cn("truncate", change.kind === "deleted" && "line-through")}>
            {name}
          </span>
        }
        detail={folderSummary(folder)}
        notice={notice}
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

/** What the Work does to a folder, in the quiet line under its name. */
function folderSummary(folder: NonNullable<ChangeGroup<ReviewFileTarget>["folder"]>): string {
  const { change } = folder;
  const was = change.kind === "changed" ? change.was : null;
  const moved = change.kind === "changed" ? change.moved : null;
  const into = moved && moved !== "top" ? moved.into : null;
  const movedLine = moved === "top" ? t`Moving to the top` : into ? t`Moving into ${into}` : null;
  return change.kind === "new"
    ? t`New`
    : change.kind === "deleted"
      ? t`Deleted`
      : [was ? t`Was ${was}` : null, movedLine].filter(Boolean).join(". ");
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
      title={<WorkName work={work} />}
      detail={<Plural value={count} one="# document to review" other="# documents to review" />}
    />
  );
}
