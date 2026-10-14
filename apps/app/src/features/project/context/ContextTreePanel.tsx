/** Project document tree. Chat resources have no ordinary Editor tabs or sidebar sections. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { FilePlus, FolderPlus, ImportIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { destinationOf, isImportScheme } from "@/features/import/destination";
import { ImportMenuItems } from "@/features/import/ImportMenuItems";
import {
  type PickKind,
  useImportsSnapshot,
  useOptionalImports,
} from "@/features/import/ImportProvider";
import { canPickFolders } from "@/features/import/SelectionPicker";
import { type ImportRowInfo, rowId, rowKind } from "@/features/import/tree-rows";
import { useImportedTree } from "@/features/import/use-imported-tree";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "./ContextEntryActions";
import { TreeChildren, type TreeEnv, TreeEnvProvider } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import {
  EDITOR_CONTEXT_SCHEMES,
  schemeAllowsCreation,
  schemeIcon,
  schemeLabel,
} from "./context-schemes";
import { ImportRunMark } from "./ImportRunMark";
import { PaneHeaderActionButton, RailPaneHeader } from "./RailPaneHeader";
import { type TreeCreationRequest, useOptionalTreeCreation } from "./TreeCreationProvider";
import {
  dragEdgeScroll,
  type TreeDropRoutes,
  TreeDropScope,
  type TreeDropTarget,
  useTreeDropTarget,
} from "./tree-drop/tree-drop";
import { treeFolderIds } from "./tree-expansion-state";
import { useTreeExpansion } from "./use-tree-expansion";

/** Left pad (px) for a row at `depth` — depth 1 = a section's direct child. */
function rowPaddingLeft(depth: number): number {
  return 8 + depth * 16;
}

export type ContextTreePanelProps = {
  projectId: string;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  /** Scheme of the currently active file (drives section auto-expand). */
  activeScheme: ProjectContextTreeScheme | null;
  /** Path of the currently active file inside `activeScheme`'s tree. */
  activePath: string | null;
  /** Called when the user picks a file row in any scheme section. */
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  creating?: TreeCreationRequest | null;
  onRequestCreate?: (request: TreeCreationRequest) => void;
  onCreateDone?: () => void;
};

/**
 * VS Code-style multi-scheme file tree. Each context scheme renders as a
 * collapsible top-level section with hover "New file / New folder" actions.
 * Every section's tree query runs from rail mount — collapsed panes just
 * don't render the data yet — so the first expand after a reload paints from
 * cache instead of flashing a load. A selection landing in a section
 * auto-opens it once; after that the user's toggle wins, even while the
 * section holds the active doc.
 */
export function ContextTreePanel({
  projectId,
  editorWorkId,
  activeScheme,
  activePath,
  onSelectFile,
  creating: controlledCreating,
  onRequestCreate: controlledRequestCreate,
  onCreateDone: controlledCreateDone,
}: ContextTreePanelProps) {
  const controller = useOptionalTreeCreation();
  const creating = controlledCreating ?? controller?.request ?? null;
  const onRequestCreate = controlledRequestCreate ?? controller?.requestCreate;
  const onCreateDone = controlledCreateDone ?? controller?.completeCreate;
  if (!onRequestCreate || !onCreateDone) {
    throw new Error("ContextTreePanel requires creation controls");
  }
  const schemes = EDITOR_CONTEXT_SCHEMES;
  const scroller = useRef<HTMLDivElement>(null);
  const catalogs = useContextCatalogViews(projectId, schemes, { workId: editorWorkId });
  const renderScheme = (scheme: (typeof EDITOR_CONTEXT_SCHEMES)[number]) => (
    <SchemeSection
      key={`${projectId}:${scheme}:${isWorkScopedProjectContextScheme(scheme) ? editorWorkId : "project"}`}
      projectId={projectId}
      editorWorkId={editorWorkId}
      scheme={scheme}
      catalogState={catalogs[scheme]}
      activeScheme={activeScheme}
      activePath={activePath}
      onSelectFile={onSelectFile}
      creating={
        creating?.scheme === scheme
          ? { kind: creating.kind, parentPath: creating.parentPath }
          : null
      }
      onRequestCreate={(kind, parentPath) => onRequestCreate({ scheme, kind, parentPath })}
      onCreateDone={onCreateDone}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* The destination rows own the sidebar's single rule. Explorer panes
          stay on one uninterrupted rail material beneath it. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag is a pointer shortcut; every drop has a menu path (Import… on the same header or folder). */}
      <div
        ref={scroller}
        onDragOver={(event) => dragEdgeScroll(scroller.current, event)}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2"
      >
        {schemes.map(renderScheme)}
      </div>
    </div>
  );
}

function SchemeSection({
  catalogState,
  projectId,
  editorWorkId,
  scheme,
  activeScheme,
  activePath,
  onSelectFile,
  creating,
  onRequestCreate,
  onCreateDone,
}: {
  catalogState: ReturnType<typeof useContextCatalogViews>[ProjectContextTreeScheme];
  projectId: string;
  editorWorkId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onCreateDone: () => void;
}) {
  // `expanded` is the pane's only open state. Holding the active doc must
  // NOT keep a pane open (Jimmy: "we should still be able to collapse"):
  // selection and creation changes below expand it as one-shot events, so a
  // later user collapse sticks until the user reopens it or a new selection
  // lands inside.
  const { isComplete, isError, refetch } = catalogState;
  const imports = useOptionalImports();
  const catalog = catalogState.catalog;
  const tree = useImportedTree(catalog, scheme);
  const folderIds = useMemo(() => {
    if (!tree || !isComplete) return null;
    return treeFolderIds((parentId) =>
      tree
        .rows(parentId ?? tree.root.entryId)
        .filter((row) => rowKind(row) === "dir")
        .map(rowId),
    );
  }, [tree, isComplete]);
  const { expanded, setExpanded, isExpanded, toggleEntry, setExpandedEntryIds } = useTreeExpansion(
    projectId,
    `editor:${scheme}:${isWorkScopedProjectContextScheme(scheme) ? editorWorkId : "project"}`,
    folderIds,
  );
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
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

  // A new import opens its area and its destination folder; its new top-level folders
  // open one level as the run knows them (their ids are known from the pick).
  const importSnapshot = useImportsSnapshot(imports?.coordinator ?? null);
  const arrived = useRef(new Set<string>());
  const opened = useRef(new Set<string>());
  useEffect(() => {
    for (const { importId, target } of importSnapshot.imports) {
      if (!target?.schemes.includes(scheme as never)) continue;
      const first = !arrived.current.has(importId);
      const fresh = target.rootIds.filter((id) => !opened.current.has(id));
      if (!first && fresh.length === 0) continue;
      arrived.current.add(importId);
      for (const id of fresh) opened.current.add(id);
      if (first) {
        setExpanded(true);
        if (
          target.destination &&
          target.destination.scheme === scheme &&
          target.destination.path !== "/"
        )
          revealPath(target.destination.path);
      }
      setExpandedEntryIds((current) => {
        const next = { ...current };
        for (const id of fresh) next[id] = true;
        const here = target.destination?.scheme === scheme ? target.destination : null;
        const destination =
          first && here
            ? (here.folderId ??
              (here.path !== "/" ? catalog?.findPath(here.path)?.entryId : undefined))
            : undefined;
        if (destination) next[destination] = true;
        return next;
      });
    }
  }, [importSnapshot, scheme, setExpanded, revealPath, setExpandedEntryIds, catalog]);

  useEffect(() => {
    if (!activeLocationPath) {
      revealed.current = null;
      return;
    }
    if (!catalog?.findPath(activeLocationPath) || revealed.current === activeLocationPath) return;
    revealed.current = activeLocationPath;
    setExpanded(true);
    revealPath(parentContextPath(activeLocationPath));
  }, [activeLocationPath, catalog, revealPath, setExpanded]);

  useEffect(() => {
    if (!creating) return;
    setExpanded(true);
    revealPath(creating.parentPath);
  }, [creating, revealPath, setExpanded]);

  const requestCreate = useCallback(
    (kind: ContextCreateKind, parentPath: string) => {
      setExpanded(true);
      revealPath(parentPath);
      onRequestCreate(kind, parentPath);
    },
    [onRequestCreate, revealPath, setExpanded],
  );

  // Catalogs stay warm while collapsed so a newly created row can resolve and open.
  useEffect(() => {
    if (!pendingOpenPath || !catalog) return;
    const entry = catalog.findPath(pendingOpenPath);
    if (entry?.kind !== "file") return;
    const file = entry;
    onSelectFile(scheme, file);
    setPendingOpenPath(null);
  }, [pendingOpenPath, catalog, onSelectFile, scheme]);

  const importable = imports !== null && isImportScheme(scheme);
  const pickImport = imports?.pick;
  const dropImport = imports?.drop;
  const importRoutes = useMemo<TreeDropRoutes>(
    () => ({
      files: {
        accepts: (target) => destinationOf(target.scheme, target.folder) !== null,
        drop: (target, items) => {
          const destination = destinationOf(target.scheme, target.folder);
          if (destination) dropImport?.(destination, items);
        },
      },
    }),
    [dropImport],
  );
  const deleteConfirm = useDeleteConfirmation({ projectId });
  const env = useMemo<TreeEnv | null>(
    () =>
      tree
        ? ({
            projectId,
            owner: { workId: editorWorkId },
            scheme,
            capabilities: [
              "rename",
              "move",
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
                }
              : undefined,
            onSelectFile,
            onRequestDelete: deleteConfirm.requestDelete,
            importHere: importable
              ? {
                  folders: canPickFolders(),
                  start: (folder, kind) => {
                    const destination = destinationOf(scheme, folder);
                    if (destination) pickImport?.(destination, kind);
                  },
                }
              : undefined,
            tree,
            isExpanded,
            toggleEntry,
          } satisfies TreeEnv)
        : null,
    [
      projectId,
      editorWorkId,
      scheme,
      activeScheme,
      activePath,
      creating,
      onSelectFile,
      requestCreate,
      deleteConfirm.requestDelete,
      importable,
      pickImport,
      onCreateDone,
      isExpanded,
      toggleEntry,
      tree,
    ],
  );

  const handleExpandedChange = (next: boolean) => {
    if (creating) onCreateDone();
    setExpanded(next);
  };

  const header = (
    <AreaHeader
      scheme={scheme}
      expanded={expanded}
      onExpandedChange={handleExpandedChange}
      onOpenExpanded={() => setExpanded(true)}
      onRequestCreate={requestCreate}
      importInfo={tree?.statusOf(tree.root.entryId)}
      onImport={
        importable
          ? (kind) => {
              const destination = destinationOf(scheme, null);
              if (destination) pickImport?.(destination, kind);
            }
          : undefined
      }
    />
  );

  return (
    <TreeDropScope routes={importRoutes}>
      <section>
        {header}
        {expanded && tree && env ? (
          <TreeEnvProvider value={env}>
            <div>
              <TreeChildren parentId={tree.root.entryId} parentPath="" depth={1} />
              {/* "No context files yet." is a claim about the tree, so it waits
                for a RESOLVED tree. While the query is in flight with nothing
                cached the pane body stays blank (no spinner) — prefetch at
                mount makes that window nearly unhittable. */}
              {isError ? (
                <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
              ) : tree.rows(tree.root.entryId).length === 0 && !creating ? (
                <EmptyHint depth={1}>
                  <Trans>No context files yet.</Trans>
                </EmptyHint>
              ) : null}
            </div>
          </TreeEnvProvider>
        ) : null}
        <DeleteConfirmationDialog
          target={deleteConfirm.target}
          isPending={deleteConfirm.isPending}
          error={deleteConfirm.error}
          onCancel={deleteConfirm.cancel}
          onConfirm={deleteConfirm.confirm}
        />
      </section>
    </TreeDropScope>
  );
}

/** An area's header: its actions, and the area root as a drop target (it lives inside the drop scope). */
function AreaHeader({
  scheme,
  expanded,
  onExpandedChange,
  onOpenExpanded,
  onRequestCreate,
  importInfo,
  onImport,
}: {
  scheme: ProjectContextTreeScheme;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpenExpanded: () => void;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  /** What an import's own run shows on the area root: reading, or didn't start. */
  importInfo?: ImportRowInfo;
  /** Present where the area takes imports: opens the OS picker for a folder or files. */
  onImport?: (kind: PickKind) => void;
}) {
  const rootTarget = useMemo<TreeDropTarget>(() => ({ scheme, folder: null }), [scheme]);
  // Hovering a collapsed area during a drag opens it.
  const drop = useTreeDropTarget(rootTarget, { onSpring: () => !expanded && onOpenExpanded() });
  // Actions show on a collapsed header too; running one opens the area so its result is visible.
  const create = (kind: ContextCreateKind) => {
    if (!expanded) onOpenExpanded();
    onRequestCreate(kind, "");
  };
  const pick = onImport
    ? (kind: PickKind) => {
        if (!expanded) onOpenExpanded();
        onImport(kind);
      }
    : undefined;
  return (
    <RailPaneHeader
      label={schemeLabel(scheme)}
      icon={schemeIcon(scheme)}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      dropProps={drop.dropProps}
      dropState={drop.dropState}
      dropLabel={<Trans>Import here</Trans>}
      status={<ImportRunMark info={importInfo} />}
      actions={
        schemeAllowsCreation(scheme) ? (
          <>
            <PaneHeaderActionButton
              icon={FilePlus}
              label={t`New file`}
              onClick={() => create("file")}
            />
            <PaneHeaderActionButton
              icon={FolderPlus}
              label={t`New folder`}
              onClick={() => create("folder")}
            />
            {pick ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <PaneHeaderActionButton icon={ImportIcon} label={t`Import…`} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <ImportMenuItems onPick={pick} />
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}

function parentContextPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "" : path.slice(0, separator);
}

function EmptyHint({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <p
      className="py-1.5 pr-2 text-xs text-ink-subtle"
      style={{ paddingLeft: rowPaddingLeft(depth) }}
    >
      {children}
    </p>
  );
}
