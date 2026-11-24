import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { Folder as FolderIcon, Layers, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import {
  type OwnerDraftListStatus,
  useDraftLists,
  useOwnerDrafts,
} from "@/client/query/useOwnerDrafts";
import { useWorks } from "@/client/query/useWorks";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { type GoneRow, type WithGone, withGone } from "@/components/app/RowWord";
import { WorkName } from "@/components/app/WorkName";
import { contentInset, ICON_SLOT_PX, ListLine, ListRow } from "@/components/ui/list-row";
import { DisclosureMark } from "@/components/ui/marks";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import { AgentFileSave } from "@/features/agents/PackageSave";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
  noticeAction,
  useDraftNoticeWords,
  useSurfaceNotice,
} from "@/features/draft-review/CommandNotice";
import { DraftCommandStatus } from "@/features/draft-review/DraftCommandStatus";
import { changeSummary, DraftFileRow } from "@/features/draft-review/DraftFileRow";
import { folderKey } from "@/features/draft-review/draft-command-owner";
import { workDraftName } from "@/features/draft-review/draft-names";
import { type DraftNotice, workNoticeKey } from "@/features/draft-review/draft-notices";
import { ReviewActions } from "@/features/draft-review/ReviewActions";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import {
  type ChangeGroup,
  groupByChangedFolder,
  groupFiles,
  groupsOf,
  landingFaultSentence,
  type WorkTreeChanges,
} from "@/features/draft-review/tree-groups";
import { hasApply } from "@/features/draft-review/tree-line";
import type { WorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { escapeCssIdent } from "@/lib/css-selector";
import { useFocusSuccession } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../../context/context-file-icon";
import { useOpenProjectDocument } from "../../context/open-project-document";
import { type NoticePlace, useTreeNoticeWords } from "../../context/use-tree-notice-words";
import { reviewCount, useDraftsTreeChanges, useShellTreeVersion } from "../../tree-version";
import { useScopeDraftOwner, useWorkScope } from "../../use-work-scope";
import { SourcePane } from "./SourcePane";

/**
 * Whose changes the Changes tab lists: the Work picked in the sidebar, or under None the
 * chat on screen's own drafts when it has no Work (the chat Scratch rule).
 */
export type ChangesScope = {
  /** The Work the commands act for: the picked Work, else the chat on screen's (No Work for a chat's own drafts). */
  work: Work | null;
  /** The shown draft; "" when there is nothing to list (None with no chat of its own). */
  draftId: string;
  /**
   * The drafts the tab lists, each under its name when there are several (a picked Work's, which
   * Apply all presses together); else the one draft, unnamed.
   */
  drafts: readonly { id: string; name: string | null }[];
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
  const { picked, work, draftId } = useScopeDraftOwner(projectId, chatThreadId);
  const lineageCount = useOwnerDrafts(projectId, picked ? "" : draftId, {
    enabled: !picked,
  }).data?.length;
  const { works, nameOf } = useWorks(projectId);
  const chatWorkId = useDisplayedThread(projectId, chatThreadId)?.workId ?? null;
  // The shell's count is the Changes list's: the Work's changed documents and folders, from its
  // open list. The Works list's stored count is the same count for a Work whose list is not open.
  const shell = useShellTreeVersion();
  const changed = shell?.draftId === draftId && draftId ? shell.changeCount : null;
  const workDrafts = picked && shell?.work?.id === picked.id ? shell.workDrafts?.drafts : null;
  // SourcesBody's context carries this scope: a new object every render would redraw every pane.
  return useMemo(() => {
    const count = picked ? reviewCount(shell, picked) : (changed ?? lineageCount ?? 0);
    const drafts =
      workDrafts && workDrafts.length > 1
        ? workDrafts.map((draft) => ({ id: draft.id, name: workDraftName(draft) }))
        : draftId
          ? [{ id: draftId, name: null }]
          : [];
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
        draftId,
        drafts,
        heading: t`Changes in ${name}`,
        empty: t`Nothing to review in ${name}.`,
        count,
        offered: Boolean(picked) || count > 0,
        elsewhere,
      };
    }
    return {
      work,
      draftId,
      drafts,
      heading: t`Changes in this chat`,
      empty: t`Nothing to review in this chat.`,
      count,
      offered: Boolean(draftId) && count > 0,
      elsewhere,
    };
  }, [picked, work, draftId, workDrafts, lineageCount, works, nameOf, chatWorkId, changed, shell]);
}

/**
 * One draft's rows as the tab shows them, read in the tab so its bar acts on what is drawn: its
 * folders and documents in the list's order, and the rows a press took that still say something.
 */
type DraftSection = {
  draftId: string;
  heading: string | null;
  /** The draft's list as read; its `draftId` is null until it has come. */
  list: OwnerDraftListStatus;
  tree: WorkTreeChanges | null;
  /** Its rows' files, in the list's order. */
  files: readonly ReviewFileTarget[];
  /** The folder changes Apply all takes along: every one that can land. */
  folders: readonly { id: string; name: string }[];
  /** The rows as drawn, folders folded away, before the gone ones go back in. */
  items: readonly ChangeItem[];
  /** Where each drawn row sits: its folder, or null at the top. */
  folderOf: ReadonlyMap<string, string | null>;
  /** An Apply the server is still running (a large Apply all). */
  applying: boolean;
};

/**
 * The scope's drafted documents, one row each in the one file order, under the folders the Work
 * changes, and in a Work with several drafts under a heading per draft. A row opens its draft;
 * its × and ✓ discard or apply that document's draft. Discard all and Apply all act on every
 * change the tab lists (the draft, or every draft of the Work), new documents, folders, moves and
 * deletes included. Each Apply is one command, which sidebar Undo takes back whole, and each
 * Discard's notice has its Undo. An Apply of several asks when it would delete documents,
 * naming each. A question takes the place of the buttons that asked it. A Discard made here shows
 * its notice in the row's place (Discard all: on every row it took); an Apply's facts sit below
 * the rows.
 *
 * An archived or deleted Work's commands go through as in any Work: Apply lands, and a Discard
 * the Work returns shows its chip on the control pressed. A frozen lineage (every chat in Trash)
 * offers no Apply, only Discard.
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
  controller: WorkDraftCommands;
  /** Whether the file is the document open in the editor. */
  isOpen: (file: ReviewFileTarget) => boolean;
  onPicked?: () => void;
}) {
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
  const touch = useCoarsePointer();
  const several = scope.drafts.length > 1;
  const draftsKey = scope.drafts.map((draft) => draft.id).join();
  const draftIds = useMemo(() => (draftsKey ? draftsKey.split(",") : []), [draftsKey]);
  const lists = useDraftLists(projectId, draftIds);
  const shell = useShellTreeVersion();
  // The shown draft's tree changes are the shell's; the others' are replayed here.
  const ownTree = shell?.draftId ?? null;
  const replayedVersions = useMemo(
    () => draftIds.filter((id) => id !== ownTree).map((id) => draftTreeVersion(id)),
    [draftIds, ownTree],
  );
  const replayed = useDraftsTreeChanges(projectId, replayedVersions);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const fold = (draftId: string, folder: string) =>
    setFolded((current) => {
      const next = new Set(current);
      const key = `${draftId}/${folder}`;
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const inFlight = (itemKey: string) => controller.owner.state(itemKey).hidden;
  const sections: DraftSection[] = scope.drafts.flatMap((draft) => {
    const list = lists.get(draft.id);
    if (!list) return [];
    const tree = draft.id === ownTree ? (shell?.tree ?? null) : (replayed.get(draft.id) ?? null);
    return [
      draftSection({
        draftId: draft.id,
        heading: several ? draft.name : null,
        list,
        tree,
        inFlight,
        isApplying: (itemKey) => controller.owner.state(itemKey).applying,
        folded: (folder) => folded.has(`${draft.id}/${folder}`),
      }),
    ];
  });
  const files = sections.flatMap((section) => section.files);
  const changedFolders = sections.flatMap((section) => section.folders);
  // A folder changed alone lists no document, and is still a change to review.
  const hasFiles = files.length > 0 || changedFolders.length > 0;

  const notice = useSurfaceNotice(controller.noticeKeys);
  const words = useDraftNoticeWords(notice);
  // One place for the tab's words: a word goes on the row that draws its node, in whichever
  // section, else on the pane's heading. A row a press took stays drawn while a word speaks for it.
  const drawnKey = sections
    .map((section) => [...section.folderOf].map(([node, parent]) => `${node}>${parent}`).join())
    .join("|");
  const place = useMemo<NoticePlace>(() => {
    const folderOf = new Map<string, string | null>();
    for (const section of sections) {
      for (const [node, parent] of section.folderOf)
        if (!folderOf.has(node)) folderOf.set(node, parent);
      for (const { key } of taken.get(section.draftId) ?? [])
        if (!folderOf.has(key)) folderOf.set(key, null);
    }
    return {
      holds: (node) => folderOf.has(node),
      parent: (node) => folderOf.get(node) ?? null,
      open: (folder) => !sections.some((section) => folded.has(`${section.draftId}/${folder}`)),
    };
    // `sections` is rebuilt every render; what it draws is in the keys below.
  }, [drawnKey, folded, notice]);
  const treeWords = useTreeNoticeWords(projectId, place);
  // A draft's notice speaks on its own rows: two drafts can hold one document. The Work's speaks
  // on every draft's.
  const speaksIn = (section: DraftSection) =>
    !notice ||
    notice.draftId === section.draftId ||
    (scope.work !== null && notice.draftId === workNoticeKey(scope.work.id));
  const wordsOf = (section: DraftSection) => (key: string) =>
    (speaksIn(section) ? words.word(key) : null) ?? treeWords.word(key);
  const shownOf = (section: DraftSection) =>
    withGone(
      section.items,
      changeKey,
      (taken.get(section.draftId) ?? []).filter(
        (row) => (speaksIn(section) && words.held(row.key)) || treeWords.word(row.key),
      ),
    );
  const shown = new Map(sections.map((section) => [section.draftId, shownOf(section)]));
  const goneRows = [...shown.values()].some((rows) => rows.some((row) => row.gone));

  /** What an Apply of several asks about first: the documents it deletes. */
  const [asking, setAsking] = useState<{
    targets: readonly ReviewFileTarget[];
    deleting: readonly ReviewFileTarget[];
  } | null>(null);
  useEffect(() => {
    if (hasFiles) return;
    setAsking(null);
  }, [hasFiles]);
  // A Discard or an Apply holds the list as the writer saw it: a row it took stays in its place,
  // saying so, while the notice speaks for it.
  const holdSection = (section: DraftSection) => {
    const keys = section.items.map(changeKey);
    taken.set(
      section.draftId,
      section.items.map((item, at) => ({
        key: item.key,
        row: item,
        after: keys.slice(0, at).reverse(),
      })),
    );
  };
  const hold = () => {
    for (const section of sections) holdSection(section);
  };
  const refsOf = (targets: readonly ReviewFileTarget[]) =>
    targets.map((file) => ({ documentId: file.documentId, itemKey: file.item.itemKey }));
  const everyItem = refsOf(files);
  const applyAll = (targets: readonly ReviewFileTarget[]) => {
    hold();
    void controller.applyMany(refsOf(targets));
  };
  const startApply = (targets: readonly ReviewFileTarget[]) => {
    const deleting = targets.filter((file) => file.item.tree?.deleted === true);
    if (deleting.length > 0) setAsking({ targets, deleting });
    else applyAll(targets);
  };
  const untitled = t`Untitled document`;
  const names = (targets: readonly ReviewFileTarget[]) =>
    targets.map((file) => reviewFileTargetName(file, untitled));
  const question: CommandQuestion | null = asking
    ? {
        kind: "apply-all",
        sentence: <ApplyAllQuestion deleting={names(asking.deleting)} />,
        keep: <Trans>Cancel</Trans>,
        confirm: <Trans>Apply all</Trans>,
        onKeep: () => setAsking(null),
        onConfirm: () => {
          setAsking(null);
          applyAll(asking.targets);
        },
        disabled: controller.dispositionLocked,
      }
    : null;
  // A Discard's focus follows to its notice's Undo; an Undo's, to the row it brings back.
  const undone = useRef<string | null>(null);
  if (notice?.kind === "discarded" && notice.documentIds[0]) undone.current = notice.documentIds[0];
  const listRef = useRef<HTMLDivElement>(null);
  useFocusSuccession(
    listRef,
    true,
    (element) =>
      noticeAction(element) ??
      (undone.current
        ? element.querySelector<HTMLElement>(
            `[data-change-row="${escapeCssIdent(undone.current)}"] button`,
          )
        : null),
  );
  const status = sections.some((section) => section.list.status === "loading")
    ? "loading"
    : sections.find((section) => section.list.status === "error")?.list;
  const [onlyFolder] = changedFolders;

  return (
    <div ref={listRef} className="contents">
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
              onDiscard={() => {
                hold();
                void controller.discardAll(
                  everyItem,
                  // A lone folder change names itself in the notice.
                  everyItem.length === 0 && changedFolders.length === 1 && onlyFolder
                    ? onlyFolder.name
                    : null,
                );
              }}
              onApply={
                files.every((file) => hasApply(file.item)) ? () => startApply(files) : undefined
              }
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
        {sections.map((section) => (
          <DraftChangesSection
            key={section.draftId}
            projectId={projectId}
            section={section}
            shown={shown.get(section.draftId) ?? []}
            controller={controller}
            notice={notice}
            wordOf={wordsOf(section)}
            touch={touch}
            isOpen={isOpen}
            onPicked={onPicked}
            folded={(folder) => folded.has(`${section.draftId}/${folder}`)}
            onFold={(folder) => fold(section.draftId, folder)}
            onCommand={() => holdSection(section)}
          />
        ))}
        {hasFiles || goneRows ? null : status === "loading" ? (
          <div className="px-2">
            <ListLine iconSlot status>
              <Trans>Loading changes…</Trans>
            </ListLine>
          </div>
        ) : status ? (
          <InlineErrorRow
            message={t`Changes couldn’t load.`}
            onRetry={status.refetch}
            actionLabel={t`Retry changes`}
          />
        ) : sections.length < scope.drafts.length ? null : (
          <div className="px-2">
            <ListLine iconSlot>{scope.empty}</ListLine>
            {scope.elsewhere ? <ElsewhereLink projectId={projectId} {...scope.elsewhere} /> : null}
          </div>
        )}
      </SourcePane>
    </div>
  );
}

/** One draft's rows as the tab shows them (`DraftSection`). */
function draftSection({
  draftId,
  heading,
  list,
  tree,
  inFlight,
  isApplying,
  folded,
}: {
  draftId: string;
  heading: string | null;
  list: OwnerDraftListStatus;
  tree: WorkTreeChanges | null;
  /** A command in flight hides its row. */
  inFlight: (itemKey: string) => boolean;
  isApplying: (itemKey: string) => boolean;
  folded: (folder: string) => boolean;
}): DraftSection {
  const listedFiles = (list.files ?? []).filter((file) => !inFlight(file.item.itemKey));
  const folderInFlight = (id: string) =>
    list.draftId !== null && inFlight(folderKey(list.draftId, id));
  // A folder whose own cut is in flight hides as a document does, once nothing under it shows.
  const shownGroups = (groups: ChangeGroup<ReviewFileTarget>[]): ChangeGroup<ReviewFileTarget>[] =>
    groups.flatMap((group) => {
      const inner = shownGroups(group.inner);
      return group.folder && folderInFlight(group.folder.id) && !group.files.length && !inner.length
        ? []
        : [{ ...group, inner }];
    });
  const grouped = tree ? groupByChangedFolder(listedFiles, tree) : null;
  const groups = grouped ? shownGroups(grouped) : [{ folder: null, files: listedFiles, inner: [] }];
  // An Apply the server is still running (a large Apply all) says so where its rows were.
  const applyingKey = (itemKey: string) => inFlight(itemKey) && isApplying(itemKey);
  const applying =
    (list.files ?? []).some((file) => applyingKey(file.item.itemKey)) ||
    (list.draftId !== null &&
      (grouped ?? []).some((group) =>
        (group.folder?.folders ?? []).some((id) =>
          applyingKey(folderKey(list.draftId as string, id)),
        ),
      ));
  const folderOf = new Map<string, string | null>();
  const walk = (group: ChangeGroup<ReviewFileTarget>, parent: string | null) => {
    const here = group.folder?.id ?? null;
    if (here) folderOf.set(here, parent);
    for (const file of group.files) folderOf.set(file.documentId, here);
    for (const inner of group.inner) walk(inner, here);
  };
  for (const group of groups) walk(group, null);
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
    ...(group.folder && folded(group.folder.id)
      ? []
      : [
          ...group.files.map((file) => ({
            key: file.documentId,
            kind: "file" as const,
            file,
            name: file.documentName || file.contextLocation?.path || t`Untitled document`,
            detail: changeSummary(file),
            depth: group.folder ? depth + 1 : 0,
          })),
          ...group.inner.flatMap((inner) => itemsOf(inner, depth + 1)),
        ]),
  ];
  return {
    draftId,
    heading,
    list,
    tree,
    // Grouped, the list's order is the groups' order.
    files: groups.flatMap(groupFiles),
    folders: groupsOf(groups).flatMap((group) =>
      group.folder && !group.folder.fault ? [{ id: group.folder.id, name: group.folder.name }] : [],
    ),
    items: groups.flatMap((group) => itemsOf(group, 0)),
    folderOf,
    applying,
  };
}

/** One draft's rows in the Changes tab, under its name when the tab lists several. */
function DraftChangesSection({
  projectId,
  section,
  shown,
  controller,
  notice,
  wordOf,
  touch,
  isOpen,
  onPicked,
  folded,
  onFold,
  onCommand,
}: {
  projectId: string;
  section: DraftSection;
  shown: readonly WithGone<ChangeItem, ChangeItem>[];
  controller: WorkDraftCommands;
  /** The tab's notice, said on the rows it took. */
  notice: DraftNotice | null;
  wordOf: (key: string) => ReactNode;
  touch: boolean;
  isOpen: (file: ReviewFileTarget) => boolean;
  onPicked?: () => void;
  folded: (folder: string) => boolean;
  onFold: (folder: string) => void;
  /** A row's own × or ✓ was pressed: the section holds its rows as they were. */
  onCommand: () => void;
}) {
  const openDocument = useOpenProjectDocument(projectId);
  const { draftId, heading, list, tree, applying } = section;
  if (!applying && shown.length === 0) return null;

  return (
    <section aria-label={heading ?? undefined} data-draft-changes={draftId}>
      {heading ? (
        <h3 className="truncate px-4 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
          {heading}
        </h3>
      ) : null}
      {applying ? (
        <div className="px-2">
          <ListLine iconSlot status>
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              <Trans>Applying</Trans>
            </span>
          </ListLine>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className="flex flex-col px-2">
          {shown.map(({ row: item, gone }) => {
            // A row a Discard took is struck through with its Undo; one an Apply took has
            // its Undo, and opens the document where it is now.
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
              return (
                <FolderGroupRow
                  key={`folder:${folder.id}`}
                  draftId={list.draftId}
                  folder={folder}
                  depth={item.depth}
                  open={!folded(folder.id)}
                  onToggle={() => onFold(folder.id)}
                  files={groupFiles(group)}
                  notice={wordOf(folder.id)}
                />
              );
            }
            const { file } = item;
            return (
              <DraftFileRow
                key={file.documentId}
                projectId={projectId}
                draftId={draftId}
                file={file}
                depth={item.depth}
                fault={tree?.faults.get(file.documentId) ?? null}
                active={isOpen(file)}
                canApply={hasApply(file.item)}
                controller={controller}
                touch={touch}
                notice={wordOf(file.documentId)}
                onCommand={onCommand}
                onPicked={onPicked}
              />
            );
          })}
        </ul>
      ) : null}
    </section>
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
 * A folder the Work changes, heading what it holds: its name, what the Work does to it, and why
 * it cannot land if it cannot; a click folds its rows. It has no × or ✓ of its own: Discard all
 * and Apply all take it. Its own command's state (pending) shows under it, as a document's does
 * under its row.
 */
function FolderGroupRow({
  draftId,
  folder,
  depth,
  open,
  onToggle,
  files,
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
  /** The Work's draft, whose folder items hold the folder's command state. */
  draftId: string | null;
}) {
  const keys = draftId ? folder.folders.map((id) => folderKey(draftId, id)) : [];
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
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("truncate", change.kind === "deleted" && "line-through")}>
              {name}
            </span>
          </span>
        }
        detail={folderSummary(folder)}
        notice={notice}
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
