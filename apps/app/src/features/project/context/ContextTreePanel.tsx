/** One area's document tree in a sidebar list: Manuscript, Knowledge, Your files, Unfiled, a Work's Scratch. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import type { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { SettledSearchField } from "@/components/ui/search-field";
import { destinationOf, isImportScheme } from "@/features/import/destination";
import {
  type PickKind,
  useImportsSnapshot,
  useOptionalImports,
} from "@/features/import/ImportProvider";
import { canPickFolders } from "@/features/import/SelectionPicker";
import { rowId, rowKind } from "@/features/import/tree-rows";
import { useImportedTree } from "@/features/import/use-imported-tree";
import { type SourceDrop, SourcePane } from "../shell/sidebar/SourcePane";
import { TreeChildren, type TreeEnv, TreeEnvProvider } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import { fileKindIcon } from "./context-file-icon";
import { schemeAllowsCreation, schemeLabel } from "./context-schemes";
import { fileSuggestion, matchFileSuggestions } from "./file-suggestions/file-suggestions";
import { ImportHeaderAction } from "./ImportHeaderAction";
import { useOptionalTreeCreation } from "./TreeCreationProvider";
import { treeFolderIds } from "./tree-expansion-state";
import { subscribeFolderReveal } from "./tree-reveal";
import { useDeleteContextEntries } from "./use-delete-context-entries";
import { useTreeExpansion } from "./use-tree-expansion";

export type CatalogState = ReturnType<typeof useContextCatalogViews>[ProjectContextTreeScheme];

/**
 * An area's rows under its name, with New file, New folder and Import in the
 * heading. Creation requests come from the shell's `TreeCreationProvider`.
 */
export function ContextTreePanel({
  catalogState,
  projectId,
  editorWorkId,
  scheme,
  activeScheme,
  activePath,
  onSelectFile,
  drop,
}: {
  catalogState: CatalogState;
  projectId: string;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  drop: SourceDrop;
}) {
  const controller = useOptionalTreeCreation();
  if (!controller) throw new Error("ContextTreePanel requires a TreeCreationProvider");
  const request = controller.request;
  const creating = useMemo(
    () =>
      request?.scheme === scheme ? { kind: request.kind, parentPath: request.parentPath } : null,
    [request, scheme],
  );
  const { requestCreate: requestTreeCreate, completeCreate: onCreateDone } = controller;
  const { catalog, isComplete, isError, refetch } = catalogState;
  const imports = useOptionalImports();
  const importedTree = useImportedTree(catalog, scheme, projectId);
  const folderIds = useMemo(() => {
    if (!importedTree || !isComplete) return null;
    return treeFolderIds((parentId) =>
      importedTree
        .rows(parentId ?? importedTree.root.entryId)
        .filter((row) => rowKind(row) === "dir")
        .map(rowId),
    );
  }, [importedTree, isComplete]);
  const { isExpanded, toggleEntry, setExpandedEntryIds } = useTreeExpansion(
    projectId,
    `editor:${scheme}:${isWorkScopedScheme(scheme) ? editorWorkId : "project"}`,
    folderIds,
  );
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
  const [createdFolder, setCreatedFolder] = useState<string | null>(null);
  const revealed = useRef<string | null>(null);

  const revealPath = useCallback(
    (path: string) => {
      if (!catalog) return;
      const segments = path.split("/").filter(Boolean);
      if (segments.length === 0) return;
      setExpandedEntryIds((current) => {
        const next = { ...current };
        let ancestor = "";
        for (const segment of segments) {
          ancestor += `/${segment}`;
          const entry = catalog.findPath(ancestor);
          if (entry?.kind === "dir") next[entry.entryId] = true;
        }
        return next;
      });
    },
    [catalog, setExpandedEntryIds],
  );

  const openFolder = useCallback(
    (folderId: string) => {
      const entry = catalog?.normalized.entries.get(folderId);
      if (entry?.kind !== "folder") return;
      revealPath(`/${entry.path.join("/")}`);
      setExpandedEntryIds((current) => ({ ...current, [entry.entryId]: true }));
    },
    [catalog, revealPath, setExpandedEntryIds],
  );

  useEffect(() => subscribeFolderReveal(openFolder), [openFolder]);

  // An import landing here opens its destination folder, once.
  const importSnapshot = useImportsSnapshot(imports?.coordinator ?? null);
  const arrived = useRef(new Set<string>());
  useEffect(() => {
    for (const { importId, summary } of importSnapshot.imports) {
      if (
        summary.projectId !== projectId ||
        summary.destination.folderUri.split(":")[0] !== scheme ||
        arrived.current.has(importId)
      )
        continue;
      arrived.current.add(importId);
      if (summary.destination.folderId) openFolder(summary.destination.folderId);
    }
  }, [importSnapshot, projectId, scheme, openFolder]);

  useEffect(() => {
    if (!activeLocationPath) {
      revealed.current = null;
      return;
    }
    if (!catalog?.findPath(activeLocationPath) || revealed.current === activeLocationPath) return;
    revealed.current = activeLocationPath;
    revealPath(parentContextPath(activeLocationPath));
  }, [activeLocationPath, catalog, revealPath]);

  const creatingParent = creating?.parentPath;
  useEffect(() => {
    if (creatingParent !== undefined) revealPath(creatingParent);
  }, [creatingParent, revealPath]);

  const requestCreate = useCallback(
    (kind: ContextCreateKind, parentPath: string) =>
      requestTreeCreate({ scheme, kind, parentPath }),
    [requestTreeCreate, scheme],
  );

  // A created file opens once its row resolves in the catalog.
  useEffect(() => {
    if (!pendingOpenPath || !catalog) return;
    const entry = catalog.findPath(pendingOpenPath);
    if (entry?.kind !== "file") return;
    onSelectFile(scheme, entry, { focus: true });
    setPendingOpenPath(null);
  }, [pendingOpenPath, catalog, onSelectFile, scheme]);

  const owner = useMemo(() => ({ workId: editorWorkId }), [editorWorkId]);
  const deleteEntries = useDeleteContextEntries(projectId);
  const importScheme = imports !== null && isImportScheme(scheme) ? scheme : null;
  const importable = importScheme !== null;
  const pickImport = imports?.pick;
  const env = useMemo<TreeEnv | null>(
    () =>
      catalog && importedTree
        ? ({
            projectId,
            owner,
            scheme,
            capabilities: [
              "rename",
              "move",
              "copy",
              ...(scheme !== "uploads" ? (["delete"] as const) : []),
            ],
            activeScheme,
            activePath,
            creation: schemeAllowsCreation(scheme)
              ? {
                  creating,
                  request: requestCreate,
                  done: onCreateDone,
                  createdFile: setPendingOpenPath,
                  createdFolder,
                  setCreatedFolder,
                }
              : undefined,
            onSelectFile,
            onRequestDelete: deleteEntries,
            importHere: importable
              ? {
                  folders: canPickFolders(),
                  start: (folder, kind) => {
                    const destination = destinationOf(scheme, folder);
                    if (destination) pickImport?.(destination, kind);
                  },
                }
              : undefined,
            catalog,
            tree: importedTree,
            isExpanded,
            toggleEntry,
          } satisfies TreeEnv)
        : null,
    [
      projectId,
      owner,
      scheme,
      activeScheme,
      activePath,
      creating,
      createdFolder,
      onSelectFile,
      requestCreate,
      deleteEntries,
      onCreateDone,
      isExpanded,
      toggleEntry,
      catalog,
      importedTree,
      importable,
      pickImport,
    ],
  );

  const actions = schemeAllowsCreation(scheme) ? (
    <>
      <IconButton label={t`New file`} onClick={() => requestCreate("file", "")}>
        <FilePlus aria-hidden />
      </IconButton>
      <IconButton label={t`New folder`} onClick={() => requestCreate("folder", "")}>
        <FolderPlus aria-hidden />
      </IconButton>
      {importScheme ? (
        <ImportHeaderAction
          scheme={importScheme}
          onPick={(kind: PickKind) => {
            const destination = destinationOf(scheme, null);
            if (destination) pickImport?.(destination, kind);
          }}
        />
      ) : null}
    </>
  ) : undefined;

  const [search, setSearch] = useState<string | null>(null);
  // The inline row lives in the tree, which a search hides: asking to create shows the tree.
  useEffect(() => {
    if (creating) setSearch(null);
  }, [creating]);
  const empty = Boolean(
    env && isComplete && importedTree && importedTree.rows(importedTree.root.entryId).length === 0,
  );
  return (
    <SourcePane
      label={schemeLabel(scheme)}
      actions={actions}
      drop={drop}
      search={
        <SettledSearchField
          quiet
          label={t`Find in ${schemeLabel(scheme)}`}
          value={search}
          onSettle={setSearch}
        />
      }
    >
      {search && catalog ? (
        <FoundFiles
          files={catalog.files()}
          scheme={scheme}
          search={search}
          activePath={activeScheme === scheme ? activePath : null}
          onOpen={(file) => onSelectFile(scheme, file, { focus: true })}
        />
      ) : env && catalog ? (
        <TreeEnvProvider value={env}>
          <div className="px-2">
            <TreeChildren parentId={catalog.root.entryId} parentPath="" depth={0} />
          </div>
        </TreeEnvProvider>
      ) : null}
      {/* A load still running and a load that failed both leave the list empty; this line says which. */}
      {search && catalog ? null : isError ? (
        <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
      ) : !isComplete || !importedTree ? (
        <div className="px-2">
          <ListLine iconSlot status>
            <Trans>Loading files…</Trans>
          </ListLine>
        </div>
      ) : empty && !creating ? (
        <div className="px-2">
          <ListLine iconSlot>
            <Trans>No files yet.</Trans>
          </ListLine>
        </div>
      ) : null}
    </SourcePane>
  );
}

/** A search's matches as one flat list, best first; the folder tells two of one name apart. */
function FoundFiles({
  files,
  scheme,
  search,
  activePath,
  onOpen,
}: {
  files: readonly ContextFile[];
  scheme: ProjectContextTreeScheme;
  search: string;
  activePath: string | null;
  onOpen: (file: ContextFile) => void;
}) {
  const byId = new Map(files.map((file) => [file.documentId, file]));
  const found = matchFileSuggestions(
    files.map((file) => fileSuggestion(scheme, file)),
    search,
  );
  if (found.length === 0)
    return (
      <div className="px-2">
        <ListLine iconSlot>
          <Trans>Nothing matches “{search}”.</Trans>
        </ListLine>
      </div>
    );
  return (
    <div className="px-2">
      {found.map((match) => {
        const file = byId.get(match.entryId);
        if (!file) return null;
        return (
          <ListRow
            key={file.documentId}
            icon={fileKindIcon(file)}
            title={file.name}
            meta={match.parents.at(-1)}
            current={file.path === activePath}
            onOpen={() => onOpen(file)}
          />
        );
      })}
    </div>
  );
}

function parentContextPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "" : path.slice(0, separator);
}
