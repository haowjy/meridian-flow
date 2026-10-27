/** Work changes and ordinary Scratch, using the same nested rows as the sidebar and phone. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkArchived } from "@meridian/contracts/works";
import { FilePlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { AddressableWork } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { TreeChildren, TreeEnvProvider } from "../context/ContextTreeRows";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { useDeleteContextEntry } from "../context/document-delete-undo";
import { EntryList, useEntryList } from "../context/entry-drag/use-entry-list";
import { SurfaceNotices } from "../context/project-notices";
import { DropRegion } from "../context/tree-drop/DropRegion";
import { useTreeDropTarget } from "../context/tree-drop/tree-drop";
import { treeFolderIds } from "../context/tree-expansion-state";
import { useTreeExpansion } from "../context/use-tree-expansion";
import { useDockDocument } from "../dock/dock-document-store";
import { useOpenDocumentInDock } from "../dock/use-open-document-in-dock";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { useWorkNoteIntake } from "./use-work-note-intake";
import { WorkChanges } from "./WorkChanges";
import { WorkFileGroup, WorkFileGroupLoading, WorkFileGroupNote } from "./WorkFileGroup";
import { NoteAttemptRow } from "./WorkFileRows";
import { workFileSearch } from "./work-files-model";

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

type WorkFilesViewProps = {
  projectId: string;
  work: AddressableWork;
  search: string;
  files: WorkFiles;
};

export function WorkFilesView({ projectId, work, search, files }: WorkFilesViewProps) {
  const { scratch, intake } = files;
  const scratchDelete = useDeleteContextEntry("work-files");
  const catalog = scratch.catalog;
  const openFile = useOpenDocumentInDock();
  const docked = useDockDocument(useProjectScreen(), projectId)?.tab.documentId;
  const folderIds = useMemo(
    () =>
      catalog && scratch.isComplete
        ? treeFolderIds((parent) =>
            catalog
              .children(parent ?? catalog.root.entryId)
              .filter((node) => node.kind === "dir")
              .map((node) => node.entryId),
          )
        : null,
    [catalog, scratch.isComplete],
  );
  const { isExpanded, toggleEntry } = useTreeExpansion(
    projectId,
    `work-files:scratch:${work.id}`,
    folderIds,
  );
  const query = search.trim().toLowerCase();
  const [searchDisclosure, setSearchDisclosure] = useState({ query, collapsed: new Set<string>() });
  if (searchDisclosure.query !== query) setSearchDisclosure({ query, collapsed: new Set() });
  const visibleIds = useMemo(() => {
    if (!catalog || !query) return undefined;
    const ids = new Set<string>();
    const visit = (parentId: string, ancestorMatches: boolean): boolean => {
      let found = false;
      for (const node of catalog.children(parentId)) {
        const matches =
          ancestorMatches ||
          node.path === files.renaming ||
          node.name.toLowerCase().includes(query);
        const descendants = node.kind === "dir" && visit(node.entryId, matches);
        if (matches || descendants) {
          ids.add(node.entryId);
          found = true;
        }
      }
      return found;
    };
    visit(catalog.root.entryId, false);
    return ids;
  }, [catalog, query, files.renaming]);
  const owner = useMemo(() => ({ workId: work.id }), [work.id]);
  const areas = useMemo(
    () =>
      catalog ? [{ scheme: "scratch" as const, owner, catalog, accepts: files.editable }] : [],
    [catalog, owner, files.editable],
  );
  const list = useEntryList({ projectId, surface: "work-files", areas });
  const matchesSearch = workFileSearch(search);
  const hasRows = catalog
    ?.children(catalog.root.entryId)
    .some((node) => !visibleIds || visibleIds.has(node.entryId));

  return (
    <div className="min-w-0 [--row-rule-inset:--spacing(2)]">
      <WorkChanges projectId={projectId} work={work} matchesSearch={matchesSearch} />
      <EntryList list={list}>
        <ScratchDropGroup catalogRootId={catalog?.root.entryId ?? null}>
          <WorkFileGroup label={t`Scratch`}>
            {scratch.isError && !catalog ? (
              <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.refetch} />
            ) : !catalog ? (
              <WorkFileGroupLoading />
            ) : hasRows ? (
              <TreeEnvProvider
                value={{
                  projectId,
                  owner,
                  scheme: "scratch",
                  catalog,
                  capabilities: files.editable ? ["rename", "move", "copy", "delete"] : ["copy"],
                  activeScheme: "scratch",
                  activePath: catalog.findDocument(docked ?? "")?.path ?? null,
                  visibleIds,
                  rename: files.renaming
                    ? { path: files.renaming, done: () => files.setRenaming(null) }
                    : undefined,
                  isExpanded: query ? (id) => !searchDisclosure.collapsed.has(id) : isExpanded,
                  toggleEntry: query
                    ? (id) =>
                        setSearchDisclosure((current) => {
                          const collapsed = new Set(current.collapsed);
                          if (collapsed.has(id)) collapsed.delete(id);
                          else collapsed.add(id);
                          return { query, collapsed };
                        })
                    : toggleEntry,
                  onRequestDelete: scratchDelete.requestDelete,
                  onSelectFile: (_scheme, file) => {
                    const tab = serverTabFromFile("scratch", file, { workId: work.id });
                    if (tab) openFile(tab);
                  },
                }}
              >
                <TreeChildren parentId={catalog.root.entryId} parentPath="" depth={0} />
              </TreeEnvProvider>
            ) : !intake.note ? (
              <WorkFileGroupNote>
                {search ? (
                  <Trans>No scratch notes match “{search}”.</Trans>
                ) : (
                  <Trans>No scratch notes yet.</Trans>
                )}
              </WorkFileGroupNote>
            ) : null}
            {intake.note ? (
              <NoteAttemptRow
                attempt={intake.note}
                onRetry={files.editable ? files.retryNote : undefined}
                onDismiss={intake.dismissNote}
              />
            ) : null}
            {scratch.isError && catalog ? (
              <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.refetch} />
            ) : null}
          </WorkFileGroup>
        </ScratchDropGroup>
      </EntryList>
      {/* Under the list, which stays visible with the sidebar collapsed. */}
      <SurfaceNotices surface="work-files" className="sticky bottom-2 mt-2 px-2" />
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
