import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { isWorkArchived } from "@meridian/contracts/works";
import { Folder as FolderIcon, Layers, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HeldNoticeRow, HeldNoticeRows } from "@/client/draft-commands/draft-command-owner";
import { type DraftNotice, workNoticeKey } from "@/client/draft-commands/draft-notices";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import {
  type OwnerDraftListStatus,
  useDraftLists,
  useOwnerDrafts,
} from "@/client/query/useOwnerDrafts";
import { useWorks } from "@/client/query/useWorks";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { type WithGone, withGone } from "@/components/app/RowWord";
import { WorkName } from "@/components/app/WorkName";
import { contentInset, ICON_SLOT_PX, ListLine, ListRow } from "@/components/ui/list-row";
import { DisclosureMark } from "@/components/ui/marks";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import { AgentFileSave } from "@/features/agents/PackageSave";
import {
  CommandNotice,
  noticeAction,
  useApplyAllQuestion,
  useDraftNoticeWords,
  useSurfaceNotice,
} from "@/features/draft-review/CommandNotice";
import { changeSummary, DraftFileRow } from "@/features/draft-review/DraftFileRow";
import { workDraftName } from "@/features/draft-review/draft-names";
import { ReviewActions } from "@/features/draft-review/ReviewActions";
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

export type ChangesScope = {
  work: Work | null;
  draftId: string;
  drafts: readonly { id: string; name: string | null }[];
  heading: string;
  empty: string;
  count: number;
  offered: boolean;
  elsewhere: { work: Work; count: number } | null;
};

export function useChangesScope(projectId: string, chatThreadId: string | null): ChangesScope {
  const { picked, work, draftId } = useScopeDraftOwner(projectId, chatThreadId);
  const lineageCount = useOwnerDrafts(projectId, picked ? "" : draftId, {
    enabled: !picked,
  }).data?.length;
  const { works, nameOf } = useWorks(projectId);
  const chatWorkId = useDisplayedThread(projectId, chatThreadId)?.workId ?? null;
  const shell = useShellTreeVersion();
  const changed = shell?.draftId === draftId && draftId ? shell.changeCount : null;
  const workDrafts = picked && shell?.work?.id === picked.id ? shell.workDrafts?.drafts : null;
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
    const named = picked ?? (work && !work.isNoWork ? work : null);
    if (named) {
      const name = nameOf(named);
      return {
        work,
        draftId,
        drafts,
        heading: t`Changes in ${name}`,
        empty: t`${name} matches Live. What you or the AI change in it shows here.`,
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
      empty: t`This chat's draft matches Live. What you or the AI change in it shows here.`,
      count,
      offered: Boolean(draftId) && count > 0,
      elsewhere,
    };
  }, [picked, work, draftId, workDrafts, lineageCount, works, nameOf, chatWorkId, changed, shell]);
}

type DraftSection = {
  draftId: string;
  heading: string | null;
  list: OwnerDraftListStatus;
  tree: WorkTreeChanges | null;
  files: readonly ReviewFileTarget[];
  folders: readonly { id: string; name: string }[];
  items: readonly ChangeItem[];
  folderOf: ReadonlyMap<string, string | null>;
  applying: boolean;
};

export function ChangesSource({
  projectId,
  scope,
  controller,
  isOpen,
  onPicked,
}: {
  projectId: string;
  scope: ChangesScope;
  controller: WorkDraftCommands;
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
        applying: controller.owner.applyingDraft(draft.id),
        folded: (folder) => folded.has(`${draft.id}/${folder}`),
      }),
    ];
  });
  const files = sections.flatMap((section) => section.files);
  const changedFolders = sections.flatMap((section) => section.folders);
  const hasFiles = files.length > 0 || changedFolders.length > 0;

  const notice = useSurfaceNotice(controller.noticeKeys);
  const words = useDraftNoticeWords(notice);
  const held = new Map(
    sections.map((section) => [
      section.draftId,
      notice
        ? controller.owner.heldNoticeRows<ChangeItem>(notice.draftId, notice.id, section.draftId)
        : [],
    ]),
  );
  const drawnKey = sections
    .map((section) => [...section.folderOf].map(([node, parent]) => `${node}>${parent}`).join())
    .join("|");
  const place = useMemo<NoticePlace>(() => {
    const folderOf = new Map<string, string | null>();
    for (const section of sections) {
      for (const [node, parent] of section.folderOf)
        if (!folderOf.has(node)) folderOf.set(node, parent);
      for (const { key } of held.get(section.draftId) ?? [])
        if (!folderOf.has(key)) folderOf.set(key, null);
    }
    return {
      holds: (node) => folderOf.has(node),
      parent: (node) => folderOf.get(node) ?? null,
      open: (folder) => !sections.some((section) => folded.has(`${section.draftId}/${folder}`)),
    };
  }, [drawnKey, folded, notice, held]);
  const treeWords = useTreeNoticeWords(projectId, place);
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
      (held.get(section.draftId) ?? []).filter(
        (row) => (speaksIn(section) && words.held(row.key)) || treeWords.word(row.key),
      ),
    );
  const shown = new Map(sections.map((section) => [section.draftId, shownOf(section)]));
  const goneRows = [...shown.values()].some((rows) => rows.some((row) => row.gone));

  const snapshotSection = (section: DraftSection): readonly HeldNoticeRow<unknown>[] => {
    const keys = section.items.map(changeKey);
    return section.items.map((item, at) => ({
      key: item.key,
      row: item,
      after: keys.slice(0, at).reverse(),
    }));
  };
  const snapshots = (only?: DraftSection): HeldNoticeRows =>
    new Map(
      (only ? [only] : sections).map((section) => [section.draftId, snapshotSection(section)]),
    );
  const {
    question,
    start: startApply,
    cancel,
  } = useApplyAllQuestion({
    deleting: files.filter((file) => file.item.tree?.deleted === true),
    apply: () => {
      void controller.pressDraft("apply", null, snapshots());
    },
    confirm: <Trans>Apply all</Trans>,
    disabled: controller.dispositionLocked,
  });
  useEffect(() => {
    if (!hasFiles) cancel();
  }, [hasFiles, cancel]);
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
                void controller.pressDraft(
                  "discard",
                  files.length === 0 && changedFolders.length === 1 && onlyFolder
                    ? onlyFolder.name
                    : null,
                  snapshots(),
                );
              }}
              onApply={files.every((file) => hasApply(file.item)) ? startApply : undefined}
            />
          ) : goneRows ? (
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
            onCommand={() => snapshots(section)}
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

function draftSection({
  draftId,
  heading,
  list,
  tree,
  applying,
  folded,
}: {
  draftId: string;
  heading: string | null;
  list: OwnerDraftListStatus;
  tree: WorkTreeChanges | null;
  applying: boolean;
  folded: (folder: string) => boolean;
}): DraftSection {
  const listedFiles = list.files ?? [];
  const visibleFolders = new Set(list.folderIds ?? []);
  const grouped = tree
    ? groupByChangedFolder(listedFiles, {
        ...tree,
        folders: new Set([...tree.folders].filter((id) => visibleFolders.has(id))),
      })
    : null;
  const groups = grouped ?? [{ folder: null, files: listedFiles, inner: [] }];
  const folderOf = new Map<string, string | null>();
  const walk = (group: ChangeGroup<ReviewFileTarget>, parent: string | null) => {
    const here = group.folder?.id ?? null;
    if (here) folderOf.set(here, parent);
    for (const file of group.files) folderOf.set(file.documentId, here);
    for (const inner of group.inner) walk(inner, here);
  };
  for (const group of groups) walk(group, null);
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
    files: groups.flatMap(groupFiles),
    folders: groupsOf(groups).flatMap((group) =>
      group.folder && !group.folder.fault ? [{ id: group.folder.id, name: group.folder.name }] : [],
    ),
    items: groups.flatMap((group) => itemsOf(group, 0)),
    folderOf,
    applying,
  };
}

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
  notice: DraftNotice | null;
  wordOf: (key: string) => ReactNode;
  touch: boolean;
  isOpen: (file: ReviewFileTarget) => boolean;
  onPicked?: () => void;
  folded: (folder: string) => boolean;
  onFold: (folder: string) => void;
  onCommand: () => HeldNoticeRows;
}) {
  const openDocument = useOpenProjectDocument(projectId);
  const { draftId, heading, tree, applying } = section;
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

const NOTHING = () => {};

function FolderGroupRow({
  folder,
  depth,
  open,
  onToggle,
  files,
  notice,
}: {
  notice: ReactNode;
  folder: NonNullable<ChangeGroup<ReviewFileTarget>["folder"]>;
  depth: number;
  open: boolean;
  onToggle: () => void;
  files: readonly ReviewFileTarget[];
}) {
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
          folder.fault ? (
            <div className="pl-1">
              <InlineErrorRow
                message={landingFaultSentence(folder.fault)}
                className="p-0 text-xs"
              />
            </div>
          ) : null
        }
      />
    </li>
  );
}

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
