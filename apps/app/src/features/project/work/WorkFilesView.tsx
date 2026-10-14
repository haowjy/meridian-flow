/**
 * Work Files tab: the Work's changes to review and its scratch notes as one
 * grouped list in the same row grammar as the Chats tab and the Editor's recents.
 * `useWorkFiles` owns the tab's state so the page toolbar can host its actions;
 * a new note on its way in is `useWorkNoteIntake`'s. An archived Work is not
 * `editable`: New note stays in place but disabled, rows only open, and a
 * refused note offers no Retry.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkArchived } from "@meridian/contracts/works";
import { FilePlus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { CatalogDirectory } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { AddressableWork } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "../context/ContextEntryActions";
import { MoveNotice } from "../context/entry-drag/move-notice";
import { EntrySelectionProvider, useEntrySelection } from "../context/entry-drag/selection";
import { useEntryMoveRoute } from "../context/entry-drag/use-entry-move-route";
import { DropRegion } from "../context/tree-drop/DropRegion";
import {
  type TreeDropRoutes,
  TreeDropScope,
  type TreeDropTarget,
  useTreeDropTarget,
} from "../context/tree-drop/tree-drop";
import { useTreeExpansion } from "../context/use-tree-expansion";
import { RuledList, type RuledRow } from "../RuledList";
import { useWorkNoteIntake } from "./use-work-note-intake";
import { WorkChanges } from "./WorkChanges";
import { WorkFileGroup, WorkFileGroupLoading, WorkFileGroupNote } from "./WorkFileGroup";
import { FolderRow, NoteAttemptRow, ScratchFileRow } from "./WorkFileRows";
import {
  catalogSiblings,
  compareTreePlaces,
  type TreePlace,
  workFileSearch,
} from "./work-files-model";

export function useWorkFiles(projectId: string, work: AddressableWork) {
  const scratch = useContextCatalogView(projectId, "scratch", { workId: work.id });
  const intake = useWorkNoteIntake(projectId, work.id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const scratchNames = () =>
    scratch.catalog?.children(scratch.catalog.root.entryId).map((entry) => entry.name) ?? [];
  // A new note opens for naming as soon as the server has it. It sits at the
  // Scratch root, and catalog paths are rooted.
  const named = (name: string | null) => {
    if (name) setRenaming(`/${name}`);
  };
  return {
    /** Whether the writer may add, rename or delete this Work's files. */
    editable: !isWorkArchived(work),
    scratch,
    intake,
    renaming,
    setRenaming,
    createNote: () => void intake.createNote(scratchNames()).then(named),
    retryNote: () => void intake.retryNote().then(named),
  };
}
export type WorkFiles = ReturnType<typeof useWorkFiles>;

/** The Files tab's toolbar action: the jade New note. */
export function WorkFilesActions({ files }: { files: WorkFiles }) {
  return (
    <Button
      size="sm"
      disabled={!files.editable || files.intake.note?.state === "pending" || !files.scratch.catalog}
      onClick={files.createNote}
      aria-label={t`New note`}
      className="[@media(pointer:coarse)]:min-h-11"
    >
      <FilePlus aria-hidden />
      <span className="max-sm:hidden" aria-hidden>
        <Trans>New note</Trans>
      </span>
    </Button>
  );
}

export function WorkFilesView({
  projectId,
  work,
  search,
  files,
}: {
  projectId: string;
  work: AddressableWork;
  search: string;
  files: WorkFiles;
}) {
  const { scratch, intake } = files;
  const scratchDelete = useDeleteConfirmation({ projectId });
  const scratchRoot = scratch.catalog?.root.entryId;
  const scratchFolders =
    scratch.catalog && scratchRoot
      ? scratch.catalog
          .children(scratchRoot)
          .filter((node): node is CatalogDirectory => node.kind === "dir")
      : [];
  const folderIds = useMemo(
    () =>
      scratch.catalog && scratch.isComplete
        ? scratch.catalog
            .children(scratch.catalog.root.entryId)
            .filter((node) => node.kind === "dir")
            .map((node) => node.entryId)
        : null,
    [scratch.catalog, scratch.isComplete],
  );
  const { isExpanded, toggleEntry } = useTreeExpansion(
    projectId,
    `work-files:scratch:${work.id}`,
    folderIds,
  );
  const expandedPaths = scratchFolders
    .filter((folder) => isExpanded(folder.entryId))
    .map((folder) => folder.path);
  const scratchFiles =
    scratch.catalog
      ?.files()
      .filter(
        (file) =>
          file.parentId === scratchRoot ||
          expandedPaths.some((path) => file.path.startsWith(`${path}/`)),
      ) ?? [];
  const catalog = scratch.catalog;
  const owner = useMemo(() => ({ workId: work.id }), [work.id]);
  const areas = useMemo(
    () =>
      catalog ? [{ scheme: "scratch" as const, owner, catalog, movable: files.editable }] : [],
    [catalog, owner, files.editable],
  );
  const selection = useEntrySelection();
  const onLanded = useCallback(
    (target: TreeDropTarget) => {
      const folderId = target.folder?.entryId;
      if (folderId && !isExpanded(folderId)) toggleEntry(folderId);
    },
    [isExpanded, toggleEntry],
  );
  const moveRoute = useEntryMoveRoute({
    projectId,
    areas,
    selection,
    surface: "work-files",
    onLanded,
  });
  const routes = useMemo<TreeDropRoutes>(() => ({ entries: moveRoute }), [moveRoute]);
  const matchesSearch = workFileSearch(search);
  const visible = [...scratchFolders, ...scratchFiles].filter((node) => matchesSearch(node.name));

  const scratchRows = inTreeOrder([
    ...(catalog
      ? visible.map((node) => ({
          key: node.entryId,
          place: { path: node.path, folder: node.kind === "dir" },
          node:
            node.kind === "dir" ? (
              <FolderRow
                projectId={projectId}
                workId={work.id}
                siblings={catalogSiblings(scratch.catalog, node)}
                capabilities={files.editable ? ["rename", "move", "delete"] : []}
                onRequestDelete={scratchDelete.requestDelete}
                folder={node}
                catalog={catalog}
                open={isExpanded(node.entryId)}
                onToggle={() => toggleEntry(node.entryId)}
              />
            ) : (
              <ScratchFileRow
                projectId={projectId}
                workId={work.id}
                file={node}
                catalog={catalog}
                siblings={catalogSiblings(scratch.catalog, node)}
                capabilities={files.editable ? ["rename", "move", "delete"] : []}
                onRequestDelete={scratchDelete.requestDelete}
                requestRename={files.renaming === node.path}
                onRenameDone={() => files.setRenaming(null)}
              />
            ),
        }))
      : []),
    ...(intake.note
      ? [
          {
            key: intake.note.key,
            place: attemptPlace(intake.note),
            node: (
              <NoteAttemptRow
                attempt={intake.note}
                onRetry={files.editable ? files.retryNote : undefined}
                onDismiss={intake.dismissNote}
              />
            ),
          },
        ]
      : []),
  ]);

  return (
    <div className="min-w-0 [--row-rule-inset:--spacing(2)]">
      <WorkChanges projectId={projectId} work={work} matchesSearch={matchesSearch} />
      <TreeDropScope routes={routes}>
        <EntrySelectionProvider selection={selection}>
          <ScratchDropGroup catalogRootId={catalog?.root.entryId ?? null}>
            <WorkFileGroup label={t`Scratch`}>
              {scratch.isError ? (
                <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.refetch} />
              ) : !scratch.catalog ? (
                <WorkFileGroupLoading />
              ) : scratchRows.length ? (
                <RuledList className="-mx-2" rows={scratchRows} />
              ) : (
                <WorkFileGroupNote>
                  {search ? (
                    <Trans>No scratch notes match “{search}”.</Trans>
                  ) : (
                    <Trans>No scratch notes yet.</Trans>
                  )}
                </WorkFileGroupNote>
              )}
            </WorkFileGroup>
          </ScratchDropGroup>
        </EntrySelectionProvider>
      </TreeDropScope>
      <MoveNotice surface="work-files" className="sticky bottom-2 mt-2" />
      <DeleteConfirmationDialog
        target={scratchDelete.target}
        isPending={scratchDelete.isPending}
        error={scratchDelete.error}
        onCancel={scratchDelete.cancel}
        onConfirm={() => void scratchDelete.confirm()}
      />
    </div>
  );
}

/** The whole Scratch group is its top level: a drop on the heading or between rows files there. */
function ScratchDropGroup({
  catalogRootId,
  children,
}: {
  catalogRootId: string | null;
  children: React.ReactNode;
}) {
  const drop = useTreeDropTarget({
    scheme: "scratch",
    catalogRootId: catalogRootId ?? "scratch:loading",
    folder: null,
  });
  return (
    <div {...drop.dropProps}>
      <DropRegion state={drop.dropState}>{children}</DropRegion>
    </div>
  );
}

/** A new note lands at the Scratch root, under its own name. */
const attemptPlace = (attempt: { name: string }): TreePlace => ({
  path: `/${attempt.name}`,
  folder: false,
});

function inTreeOrder(rows: (RuledRow & { place: TreePlace })[]): RuledRow[] {
  return rows
    .sort((left, right) => compareTreePlaces(left.place, right.place))
    .map(({ key, node }) => ({ key, node }));
}
