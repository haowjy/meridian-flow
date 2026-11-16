/** One area's document tree in a sidebar list: Manuscript, Knowledge, Your files, Unfiled, a Work's Scratch. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, Folder, FolderPlus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeViewResult } from "@/client/query/useProjectTree";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { SettledSearchField } from "@/components/ui/search-field";
import type { TreeFile, TreeView } from "@/core/project-tree/tree-view";
import { destinationOf, isImportScheme } from "@/features/import/destination";
import { type PickKind, useOptionalImports } from "@/features/import/ImportProvider";
import { canPickFolders } from "@/features/import/SelectionPicker";
import { rowId, rowKind } from "@/features/import/tree-rows";
import { useImportedTree } from "@/features/import/use-imported-tree";
import { useOpenCreatedDocument } from "../review-launch";
import { type SourceDrop, SourcePane } from "../shell/sidebar/SourcePane";
import { useShellTreeVersion } from "../tree-version";
import { TreeChildren, type TreeEnv, TreeEnvProvider } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import { schemeAllowsCreation, schemeLabel } from "./context-schemes";
import { matchFileSuggestions, treeFileSuggestions } from "./file-suggestions/file-suggestions";
import { ImportHeaderAction } from "./ImportHeaderAction";
import { useOptionalTreeCreation } from "./TreeCreationProvider";
import { treeFolderIds } from "./tree-expansion-state";
import { revealPlaced, subscribePlacedReveal } from "./tree-reveal";
import { useDeleteContextEntries } from "./use-delete-context-entries";
import type { EntryCapabilities } from "./use-entry-interaction";
import { useTreeExpansion } from "./use-tree-expansion";
import { NOWHERE, treePlace, useTreeNoticeWords } from "./use-tree-notice-words";

/** What a row offers in a tree that takes no change: its documents still copy out. */
const READ_ONLY: EntryCapabilities = ["copy"];

type ContextTreeInput = {
  treeState: TreeViewResult;
  writable: boolean;
  projectId: string;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  scheme: ProjectContextTreeScheme;
  activeDocumentId: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: TreeFile,
    options?: { focus?: true },
  ) => void;
  /** A file the writer picked opened: the phone's drawer closes. */
  onPicked?: () => void;
  /** The folder the rows start at (`/.agents`); the source's top when absent. */
  rootPath?: string;
  /** A note on a file's row, after its name. */
  meta?: TreeEnv["meta"];
  folderEnd?: TreeEnv["folderEnd"];
  crossedOut?: TreeEnv["crossedOut"];
};

export type ContextTree = ReturnType<typeof useContextTree>;

/**
 * One source's rows and what acts on them: expansion, reveal of main's document, inline create,
 * and import. A pane renders it with `ContextTreeBody` and puts `requestCreate` in its heading.
 */
export function useContextTree({
  treeState,
  writable,
  projectId,
  editorWorkId,
  scheme,
  activeDocumentId,
  onSelectFile,
  onPicked,
  rootPath = "",
  meta,
  folderEnd,
  crossedOut,
}: ContextTreeInput) {
  const controller = useOptionalTreeCreation();
  if (!controller) throw new Error("ContextTreePanel requires a TreeCreationProvider");
  const request = controller.request;
  const creating = useMemo(
    () =>
      request?.scheme === scheme && (rootPath === "" || request.parentPath.startsWith(rootPath))
        ? { kind: request.kind, parentPath: request.parentPath }
        : null,
    [request, scheme, rootPath],
  );
  const { requestCreate: requestTreeCreate, completeCreate: onCreateDone } = controller;
  const { tree, isComplete, isError } = treeState;
  const imports = useOptionalImports();
  const importedTree = useImportedTree(tree, scheme, projectId);
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
  const shell = useShellTreeVersion();
  const changed = shell?.showing === "live" && shell.offered ? shell.changed : null;
  const activeLocationPath =
    (activeDocumentId && tree?.findDocument(activeDocumentId)?.path) || null;
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
  const [createdFolder, setCreatedFolder] = useState<string | null>(null);
  // Where the header's New file and New folder go: the folder the writer last opened or closed
  // into, else the open document's folder, else the top.
  const [place, setPlace] = useState<{ folderPath: string; activePath: string | null } | null>(
    null,
  );
  const revealed = useRef<string | null>(null);

  const revealPath = useCallback(
    (path: string) => {
      if (!tree) return;
      const segments = path.split("/").filter(Boolean);
      if (segments.length === 0) return;
      setExpandedEntryIds((current) => {
        const next = { ...current };
        let ancestor = "";
        for (const segment of segments) {
          ancestor += `/${segment}`;
          const entry = tree.findPath(ancestor);
          if (entry?.kind === "dir") next[entry.entryId] = true;
        }
        return next;
      });
    },
    [tree, setExpandedEntryIds],
  );

  const openFolder = useCallback(
    (folderId: string) => {
      const entry = tree?.entry(folderId);
      if (entry?.kind !== "dir") return;
      revealPath(entry.path);
      setExpandedEntryIds((current) => ({ ...current, [entry.entryId]: true }));
    },
    [tree, revealPath, setExpandedEntryIds],
  );

  const openPlaced = useRef(openFolder);
  openPlaced.current = openFolder;
  useEffect(() => subscribePlacedReveal((folderId) => openPlaced.current(folderId)), []);

  useEffect(() => {
    if (!activeLocationPath) {
      revealed.current = null;
      return;
    }
    if (revealed.current === activeLocationPath) return;
    revealed.current = activeLocationPath;
    revealPath(parentContextEntryPath(activeLocationPath));
  }, [activeLocationPath, tree, revealPath]);

  const creatingParent = creating?.parentPath;
  useEffect(() => {
    if (creatingParent !== undefined) revealPath(creatingParent);
  }, [creatingParent, revealPath]);

  const requestCreate = useCallback(
    (kind: ContextCreateKind, parentPath: string) =>
      requestTreeCreate({ scheme, kind, parentPath }),
    [requestTreeCreate, scheme],
  );

  // A created file opens once its row shows in the tree, in the version it was made in.
  const openCreated = useOpenCreatedDocument();
  useEffect(() => {
    if (!pendingOpenPath || !tree) return;
    const entry = tree.findPath(pendingOpenPath);
    if (entry?.kind !== "file") return;
    setPendingOpenPath(null);
    void openCreated(
      {
        documentId: entry.documentId,
        contextLocation: { scheme, path: entry.path },
        documentName: entry.name,
      },
      async () => onSelectFile(scheme, entry, { focus: true }),
      onPicked,
    );
  }, [pendingOpenPath, tree, onSelectFile, onPicked, scheme, openCreated]);

  const owner = useMemo(() => ({ workId: editorWorkId }), [editorWorkId]);
  const deleteEntries = useDeleteContextEntries(projectId);
  const importScheme =
    writable && imports !== null && rootPath === "" && isImportScheme(scheme) ? scheme : null;
  const creates = writable && schemeAllowsCreation(scheme);
  const importable = importScheme !== null;
  const pickImport = imports?.pick;
  const drawn = useMemo(() => (tree ? treePlace(tree, isExpanded) : NOWHERE), [tree, isExpanded]);
  const notices = useTreeNoticeWords(projectId, drawn);
  const env = useMemo<TreeEnv | null>(
    () =>
      tree && importedTree
        ? ({
            projectId,
            owner,
            scheme,
            capabilities: writable ? ["rename", "move", "copy", "delete"] : READ_ONLY,
            activeDocumentId,
            changed,
            meta,
            folderEnd,
            crossedOut,
            creation: creates
              ? {
                  creating,
                  request: requestCreate,
                  done: onCreateDone,
                  createdFile: setPendingOpenPath,
                  createdFolder,
                  setCreatedFolder,
                  placeAt: (folderPath) => setPlace({ folderPath, activePath: activeLocationPath }),
                }
              : undefined,
            // Opening a document is the writer's next action here: the tree's notices end.
            onSelectFile: (picked, file) => {
              notices.end();
              onSelectFile(picked, file);
            },
            notices,
            onRequestDelete: deleteEntries,
            importHere: importable
              ? {
                  folders: canPickFolders(),
                  start: (folder, kind) => {
                    const destination = destinationOf(scheme, folder);
                    if (!destination || !pickImport) return;
                    pickImport(destination, kind);
                    // The imported rows' ids come from the server: the folder opens for them.
                    if (folder) revealPlaced(folder.entryId, [], null);
                  },
                }
              : undefined,
            tree,
            rows: importedTree,
            isExpanded,
            toggleEntry,
          } satisfies TreeEnv)
        : null,
    [
      projectId,
      owner,
      scheme,
      writable,
      creates,
      activeDocumentId,
      activeLocationPath,
      changed,
      meta,
      folderEnd,
      crossedOut,
      creating,
      createdFolder,
      onSelectFile,
      notices,
      requestCreate,
      deleteEntries,
      onCreateDone,
      isExpanded,
      toggleEntry,
      tree,
      importedTree,
      importable,
      pickImport,
    ],
  );

  // Opening another document since moves the place to its folder.
  const placed =
    place && place.activePath === activeLocationPath
      ? place.folderPath
      : activeLocationPath && parentContextEntryPath(activeLocationPath);
  const inRoot = (path: string | null): path is string =>
    path !== null && (rootPath === "" || path === rootPath || path.startsWith(`${rootPath}/`));
  const here = inRoot(placed) && tree?.findPath(placed)?.kind === "dir" ? placed : rootPath;
  const root = rootPath === "" ? tree?.root : tree?.findPath(rootPath);
  const rootFolder = root?.kind === "dir" ? root : null;
  const empty = Boolean(
    env &&
      isComplete &&
      importedTree &&
      (!rootFolder || importedTree.rows(rootFolder.entryId).length === 0),
  );
  return {
    scheme,
    env,
    tree,
    isComplete,
    isError,
    loaded: Boolean(isComplete && importedTree),
    /** The folder the rows start at; null while it doesn't exist (`.agents` not made yet). */
    rootFolder: rootFolder && rootPath !== "" ? rootFolder : null,
    rootPath,
    creates,
    creating,
    here,
    empty,
    requestCreate,
    importScheme,
    pickImport,
    openFolder,
    notices,
    /** Opens the file made at this path once its row shows. */
    openWhenListed: setPendingOpenPath,
  };
}

/** A tree's rows, or the line that stands in for them: loading, unreadable, empty. */
export function ContextTreeBody({
  tree,
  emptyLine = <Trans>No files yet.</Trans>,
}: {
  tree: ContextTree;
  emptyLine?: ReactNode;
}) {
  const { env, rootFolder, rootPath } = tree;
  return (
    <>
      {env && tree.tree && (rootPath === "" || rootFolder) ? (
        <TreeEnvProvider value={env}>
          <div className="px-2">
            <TreeChildren
              parentId={rootFolder?.entryId ?? tree.tree.root.entryId}
              parentPath={rootPath}
              depth={0}
              parent={
                rootFolder
                  ? {
                      entryId: rootFolder.entryId,
                      path: rootFolder.path,
                      uri: rootFolder.uri,
                      name: rootFolder.name,
                    }
                  : null
              }
            />
          </div>
        </TreeEnvProvider>
      ) : null}
      {/* A load still running and a list the account cannot read both leave the list empty; this line says which. */}
      {tree.isError ? (
        <InlineErrorRow message={t`You can't open these files.`} />
      ) : !tree.loaded ? (
        <div className="px-2">
          <ListLine iconSlot status>
            <Trans>Loading files…</Trans>
          </ListLine>
        </div>
      ) : tree.empty && !tree.creating ? (
        <div className="px-2">
          <ListLine iconSlot>{emptyLine}</ListLine>
        </div>
      ) : null}
    </>
  );
}

/**
 * An area's rows under its name, with New file, New folder and Import in the
 * heading. Creation requests come from the shell's `TreeCreationProvider`. A tree that is not
 * `writable` (an ended Work's Scratch) offers none of them, and its rows offer only Copy.
 */
export function ContextTreePanel({
  drop,
  ...input
}: Omit<ContextTreeInput, "rootPath" | "meta" | "folderEnd" | "crossedOut"> & {
  drop: SourceDrop;
}) {
  const tree = useContextTree(input);
  const { scheme, here, requestCreate, importScheme, pickImport, creating } = tree;
  const actions = tree.creates ? (
    <>
      <IconButton label={t`New file`} onClick={() => requestCreate("file", here)}>
        <FilePlus aria-hidden />
      </IconButton>
      <IconButton label={t`New folder`} onClick={() => requestCreate("folder", here)}>
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
  return (
    <SourcePane
      label={schemeLabel(scheme)}
      actions={actions}
      notice={tree.notices.header}
      drop={drop}
      search={
        <SettledSearchField
          label={t`Find in ${schemeLabel(scheme)}`}
          value={search}
          onSettle={setSearch}
        />
      }
    >
      {search && tree.tree ? (
        <FoundEntries
          tree={tree.tree}
          scheme={scheme}
          search={search}
          activeDocumentId={input.activeDocumentId}
          onOpen={(file) => input.onSelectFile(scheme, file, { focus: true })}
          onOpenFolder={(folderId) => {
            setSearch(null);
            tree.openFolder(folderId);
            focusRow(`folder:${folderId}`);
          }}
        />
      ) : (
        <ContextTreeBody tree={tree} />
      )}
    </SourcePane>
  );
}

/**
 * A search's matches as one flat list, best first; the folder tells two of one name apart. A
 * folder found opens in place in the tree, where its menu moves or deletes it.
 */
function FoundEntries({
  tree,
  scheme,
  search,
  activeDocumentId,
  onOpen,
  onOpenFolder,
}: {
  tree: TreeView;
  scheme: ProjectContextTreeScheme;
  search: string;
  activeDocumentId: string | null;
  onOpen: (file: TreeFile) => void;
  onOpenFolder: (folderId: string) => void;
}) {
  const found = matchFileSuggestions(
    treeFileSuggestions([{ scheme, tree }]).filter((entry) => entry.path !== "/"),
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
        const entry = tree.entry(match.entryId);
        if (!entry) return null;
        if (entry.kind === "dir")
          return (
            <ListRow
              key={entry.entryId}
              icon={Folder}
              title={entry.name}
              meta={match.parents.at(-1)}
              onOpen={() => onOpenFolder(entry.entryId)}
            />
          );
        return (
          <ListRow
            key={entry.documentId}
            icon={fileKindIcon(entry)}
            title={entry.name}
            meta={match.parents.at(-1)}
            current={entry.documentId === activeDocumentId}
            onOpen={() => onOpen(entry)}
          />
        );
      })}
    </div>
  );
}

/** Brings a tree row to the top of the list, so what it holds shows below it, and focuses it once drawn. */
function focusRow(key: string) {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: "start" });
    row?.focus({ preventScroll: true });
  });
}
