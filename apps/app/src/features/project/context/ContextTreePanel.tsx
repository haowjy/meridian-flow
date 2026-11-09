/** Project document tree. Chat resources have no ordinary Editor tabs or sidebar sections. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, FolderPlus } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { dragPayloadKind } from "@/core/editor/landing/drag-payload";
import { dragEdgeScroll } from "@/core/editor/landing/edge-scroll";
import { destinationOf, isImportScheme } from "@/features/import/destination";
import {
  type PickKind,
  useImportsSnapshot,
  useOptionalImports,
} from "@/features/import/ImportProvider";
import { canPickFolders } from "@/features/import/SelectionPicker";
import { rowId, rowKind } from "@/features/import/tree-rows";
import { useImportedTree } from "@/features/import/use-imported-tree";
import { DockedRailSection } from "../shell/DockedRailSection";
import { TreeChildren, type TreeEnv, TreeEnvProvider, TreeGroup } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import {
  PROJECT_TREE_SCHEMES,
  schemeAllowsCreation,
  schemeIcon,
  schemeLabel,
} from "./context-schemes";
import { EntryList, useEntryList } from "./entry-drag/use-entry-list";
import { ImportHeaderAction } from "./ImportHeaderAction";
import { PaneHeaderActionButton, RailPaneHeader } from "./RailPaneHeader";
import { SourceHeading } from "./SourceHeading";
import { type TreeCreationRequest, useOptionalTreeCreation } from "./TreeCreationProvider";
import { AreaDropRegion } from "./tree-drop/AreaDropRegion";
import type { FilesRoute } from "./tree-drop/tree-drop";
import { treeFolderIds } from "./tree-expansion-state";
import { subscribeFolderReveal } from "./tree-reveal";
import { useDeleteContextEntry } from "./use-delete-context-entry";
import { useTreeExpansion } from "./use-tree-expansion";

/** Left pad (px) for a row at `depth` — depth 1 = a section's direct child. */
function rowPaddingLeft(depth: number): number {
  return 8 + depth * 16;
}

type ContextTreePanelProps = {
  projectId: string;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  /** Scheme of the currently active file (drives section auto-expand). */
  activeScheme: ProjectContextTreeScheme | null;
  /** Path of the currently active file inside `activeScheme`'s tree. */
  activePath: string | null;
  /** Called when the user picks a file row in any scheme section. */
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  creating?: TreeCreationRequest | null;
  onRequestCreate?: (request: TreeCreationRequest) => void;
  onCreateDone?: () => void;
  /**
   * Show one source, always open, under a plain heading (Write mode's source
   * tabs). Omitted, every project source stacks as a collapsible section.
   */
  only?: ProjectContextTreeScheme;
};

const ALWAYS_OPEN: PaneState = { expanded: true, setExpanded: () => {} };

/**
 * VS Code-style multi-scheme file tree. Each context scheme renders as a
 * collapsible top-level section with hover "New file / New folder / Import…" actions.
 * Every section's tree query runs from rail mount — collapsed panes just
 * don't render the data yet — so the first expand after a reload paints from
 * cache instead of flashing a load. A selection landing in a section
 * auto-opens it once; after that the user's toggle wins, even while the
 * section holds the active doc.
 */
export function ContextTreePanel(props: ContextTreePanelProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const imports = useOptionalImports();
  const { list, renderScheme } = useSchemeTree(props, PROJECT_TREE_SCHEMES);
  const dropImport = imports?.drop;
  const files = useMemo<FilesRoute>(
    () => ({
      verdict: (target) => {
        const destination = destinationOf(target.scheme, target.folder);
        return destination ? { kind: "accept", label: t`Import into ${destination.name}` } : null;
      },
      drop: (target, items) => {
        const destination = destinationOf(target.scheme, target.folder);
        if (destination) dropImport?.(destination, items);
      },
    }),
    [dropImport],
  );
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* The destination rows own the sidebar's single rule. Explorer panes
          stay on one uninterrupted rail material beneath it. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag is a pointer shortcut; every drop has a menu path (Move… on the row). slop-lint: allow suppression the reason is stated in this comment */}
      <div
        ref={scroller}
        onDragOver={(event) => {
          if (dragPayloadKind(Array.from(event.dataTransfer.types)) !== "none")
            dragEdgeScroll(scroller.current, event.clientY);
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2"
      >
        <EntryList list={list} files={files}>
          {props.only
            ? renderScheme(props.only, ALWAYS_OPEN, "source")
            : PROJECT_TREE_SCHEMES.map((scheme) => renderScheme(scheme))}
        </EntryList>
      </div>
    </div>
  );
}

const USER_SCHEMES = ["user"] as const;

/**
 * The writer's User documents, docked above the account row like Scratch. Its
 * own list, so a drag between it and the project tree stays quiet until a
 * crossing can offer Move or Copy.
 */
export function UserRailSection({
  resizeAgainst,
  ...props
}: ContextTreePanelProps & { resizeAgainst?: RefObject<HTMLElement | null> }) {
  const { list, renderScheme } = useSchemeTree(props, USER_SCHEMES);
  return (
    <DockedRailSection id="user" resizeAgainst={resizeAgainst}>
      {(pane) => <EntryList list={list}>{renderScheme("user", pane)}</EntryList>}
    </DockedRailSection>
  );
}

/** The writer's own files, always open, for a pane of their own (the Your files popup). */
export function UserFilesTree(props: ContextTreePanelProps) {
  const { list, renderScheme } = useSchemeTree(props, USER_SCHEMES);
  return <EntryList list={list}>{renderScheme("user", ALWAYS_OPEN, "source")}</EntryList>;
}

type PaneState = { expanded: boolean; setExpanded: (next: boolean) => void };

/** One list over `schemes`, and each scheme's section. */
function useSchemeTree(
  {
    projectId,
    editorWorkId,
    activeScheme,
    activePath,
    onSelectFile,
    creating: controlledCreating,
    onRequestCreate: controlledRequestCreate,
    onCreateDone: controlledCreateDone,
  }: ContextTreePanelProps,
  schemes: readonly ProjectContextTreeScheme[],
) {
  const controller = useOptionalTreeCreation();
  const creating = controlledCreating ?? controller?.request ?? null;
  const onRequestCreate = controlledRequestCreate ?? controller?.requestCreate;
  const onCreateDone = controlledCreateDone ?? controller?.completeCreate;
  if (!onRequestCreate || !onCreateDone) {
    throw new Error("ContextTreePanel requires creation controls");
  }
  const catalogs = useContextCatalogViews(projectId, schemes, { workId: editorWorkId });
  const list = useEntryList({
    projectId,
    areas: schemes.flatMap((scheme) => {
      const catalog = catalogs[scheme]?.catalog;
      return catalog ? [{ scheme, owner: { workId: editorWorkId }, catalog, accepts: true }] : [];
    }),
  });
  const renderScheme = (
    scheme: ProjectContextTreeScheme,
    pane?: PaneState,
    heading: "section" | "source" = "section",
  ) => (
    <SchemeSection
      heading={heading}
      key={`${projectId}:${scheme}:${isWorkScopedScheme(scheme) ? editorWorkId : "project"}`}
      projectId={projectId}
      editorWorkId={editorWorkId}
      scheme={scheme}
      catalogState={catalogs[scheme]}
      pane={pane}
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
  return { list, renderScheme };
}

function SchemeSection({
  heading,
  catalogState,
  projectId,
  editorWorkId,
  scheme,
  pane,
  activeScheme,
  activePath,
  onSelectFile,
  creating,
  onRequestCreate,
  onCreateDone,
}: {
  heading: "section" | "source";
  catalogState: ReturnType<typeof useContextCatalogViews>[ProjectContextTreeScheme];
  projectId: string;
  editorWorkId: string | null;
  scheme: ProjectContextTreeScheme;
  /** A docked section's open state, owned by the rail instead of the tree. */
  pane?: PaneState;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onCreateDone: () => void;
}) {
  // `expanded` is the pane's only open state. Holding the active doc must
  // NOT keep a pane open (Jimmy: "we should still be able to collapse"):
  // selection and creation changes below expand it as one-shot events, so a
  // later user collapse sticks until the user reopens it or a new selection
  // lands inside.
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
  const expansion = useTreeExpansion(
    projectId,
    `editor:${scheme}:${isWorkScopedScheme(scheme) ? editorWorkId : "project"}`,
    folderIds,
  );
  const { isExpanded, toggleEntry, setExpandedEntryIds } = expansion;
  const expanded = pane?.expanded ?? expansion.expanded;
  const setExpanded = pane?.setExpanded ?? expansion.setExpanded;
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

  const openFolder = useCallback(
    (folderId: string) => {
      const entry = catalog?.normalized.entries.get(folderId);
      if (entry?.kind !== "folder") return;
      setExpanded(true);
      revealPath(`/${entry.path.join("/")}`);
      setExpandedEntryIds((current) => ({ ...current, [entry.entryId]: true }));
    },
    [catalog, revealPath, setExpanded, setExpandedEntryIds],
  );

  useEffect(() => subscribeFolderReveal(openFolder), [openFolder]);

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
      setExpanded(true);
      if (summary.destination.folderId) openFolder(summary.destination.folderId);
    }
  }, [importSnapshot, projectId, scheme, setExpanded, openFolder]);

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
    onSelectFile(scheme, file, { focus: true });
    setPendingOpenPath(null);
  }, [pendingOpenPath, catalog, onSelectFile, scheme]);

  const owner = useMemo(() => ({ workId: editorWorkId }), [editorWorkId]);
  const deletion = useDeleteContextEntry(projectId);
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
                }
              : undefined,
            onSelectFile,
            onRequestDelete: deletion.requestDelete,
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
      onSelectFile,
      requestCreate,
      deletion.requestDelete,
      onCreateDone,
      isExpanded,
      toggleEntry,
      catalog,
      importedTree,
      importable,
      pickImport,
    ],
  );

  const handleExpandedChange = (next: boolean) => {
    if (creating) onCreateDone();
    setExpanded(next);
  };

  const importAction = importScheme ? (
    <ImportHeaderAction
      scheme={importScheme}
      onPick={(kind: PickKind) => {
        const destination = destinationOf(scheme, null);
        if (!destination) return;
        setExpanded(true);
        pickImport?.(destination, kind);
      }}
    />
  ) : null;
  const header = (dropProps: React.HTMLAttributes<HTMLElement>) =>
    heading === "source" ? (
      <SourceHeading
        label={schemeLabel(scheme)}
        dropProps={dropProps}
        extra={importAction}
        onCreate={schemeAllowsCreation(scheme) ? (kind) => requestCreate(kind, "") : undefined}
      />
    ) : (
      <RailPaneHeader
        label={schemeLabel(scheme)}
        icon={schemeIcon(scheme)}
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
        dropProps={dropProps}
        actions={
          schemeAllowsCreation(scheme) ? (
            <>
              <PaneHeaderActionButton
                icon={FilePlus}
                label={t`New file`}
                onClick={() => requestCreate("file", "")}
              />
              <PaneHeaderActionButton
                icon={FolderPlus}
                label={t`New folder`}
                onClick={() => requestCreate("folder", "")}
              />
              {importAction}
            </>
          ) : undefined
        }
      />
    );

  return (
    <section className={pane ? "flex min-h-0 flex-col" : undefined}>
      <AreaDropRegion
        scheme={scheme}
        catalogRootId={catalog?.root.entryId ?? null}
        reveal={() => !expanded && setExpanded(true)}
        header={header}
        className={pane ? "flex min-h-0 flex-col" : undefined}
      >
        {expanded ? (
          // Docked, the header stays put and the rows scroll under it.
          <div className={pane ? "min-h-0 overflow-y-auto overflow-x-hidden pb-1" : undefined}>
            {catalog && importedTree && env ? (
              <TreeEnvProvider value={env}>
                <TreeGroup depth={1}>
                  <TreeChildren parentId={catalog.root.entryId} parentPath="" depth={1} />
                </TreeGroup>
              </TreeEnvProvider>
            ) : null}
            {/* The status line never waits on rows: a load that is still running and a
              load that failed both leave the pane empty, so the writer cannot tell
              "nothing here" from "not here yet" unless this row says which. */}
            {isError ? (
              <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
            ) : !isComplete || !importedTree ? (
              <p
                role="status"
                aria-live="polite"
                className="py-1.5 pr-2 text-xs text-ink-subtle"
                style={{ paddingLeft: rowPaddingLeft(1) }}
              >
                <Trans>Loading files…</Trans>
              </p>
            ) : null}
          </div>
        ) : null}
      </AreaDropRegion>
    </section>
  );
}

function parentContextPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "" : path.slice(0, separator);
}
