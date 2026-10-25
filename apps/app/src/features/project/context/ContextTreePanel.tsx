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
import { DockedRailSection } from "../shell/DockedRailSection";
import { TreeChildren, type TreeEnv, TreeEnvProvider, TreeGroup } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import {
  PROJECT_TREE_SCHEMES,
  schemeAllowsCreation,
  schemeIcon,
  schemeLabel,
} from "./context-schemes";
import { useDeleteContextEntry } from "./document-delete-undo";
import { EntryList, useEntryList } from "./entry-drag/use-entry-list";
import { PaneHeaderActionButton, RailPaneHeader } from "./RailPaneHeader";
import { type TreeCreationRequest, useOptionalTreeCreation } from "./TreeCreationProvider";
import { AreaDropRegion } from "./tree-drop/AreaDropRegion";
import { dragEdgeScroll } from "./tree-drop/tree-drop";
import { treeFolderIds } from "./tree-expansion-state";
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
export function ContextTreePanel(props: ContextTreePanelProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const { list, renderScheme } = useSchemeTree(props, PROJECT_TREE_SCHEMES);
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* The destination rows own the sidebar's single rule. Explorer panes
          stay on one uninterrupted rail material beneath it. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag is a pointer shortcut; every drop has a menu path (Move… on the row). */}
      <div
        ref={scroller}
        onDragOver={(event) => dragEdgeScroll(scroller.current, event)}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2"
      >
        <EntryList list={list}>
          {PROJECT_TREE_SCHEMES.map((scheme) => renderScheme(scheme))}
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
    surface: "sidebar",
    areas: schemes.flatMap((scheme) => {
      const catalog = catalogs[scheme]?.catalog;
      return catalog ? [{ scheme, owner: { workId: editorWorkId }, catalog, movable: true }] : [];
    }),
  });
  const renderScheme = (scheme: ProjectContextTreeScheme, pane?: PaneState) => (
    <SchemeSection
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
  const folderIds = useMemo(() => {
    if (!catalog || !isComplete) return null;
    return treeFolderIds((parentId) =>
      catalog
        .children(parentId ?? catalog.root.entryId)
        .filter((entry) => entry.kind === "dir")
        .map((entry) => entry.entryId),
    );
  }, [catalog, isComplete]);
  const tree = useTreeExpansion(
    projectId,
    `editor:${scheme}:${isWorkScopedScheme(scheme) ? editorWorkId : "project"}`,
    folderIds,
  );
  const { isExpanded, toggleEntry, setExpandedEntryIds } = tree;
  const expanded = pane?.expanded ?? tree.expanded;
  const setExpanded = pane?.setExpanded ?? tree.setExpanded;
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
  const deletion = useDeleteContextEntry();
  const env = useMemo<TreeEnv | null>(
    () =>
      catalog
        ? ({
            projectId,
            owner,
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
            onRequestDelete: deletion.requestDelete,
            catalog,
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
    ],
  );

  const handleExpandedChange = (next: boolean) => {
    if (creating) onCreateDone();
    setExpanded(next);
  };

  const header = (dropProps: React.HTMLAttributes<HTMLElement>) => (
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
        {expanded && catalog && env ? (
          <TreeEnvProvider value={env}>
            {/* Docked, the header stays put and the rows scroll under it. */}
            <div className={pane ? "min-h-0 overflow-y-auto overflow-x-hidden pb-1" : undefined}>
              <TreeGroup depth={1}>
                <TreeChildren parentId={catalog.root.entryId} parentPath="" depth={1} />
              </TreeGroup>
              {/* "No context files yet." is a claim about the tree, so it waits
                for a RESOLVED tree. While the query is in flight with nothing
                cached the pane body stays blank (no spinner) — prefetch at
                mount makes that window nearly unhittable. */}
              {isError ? (
                <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
              ) : catalog.children(catalog.root.entryId).length === 0 && !creating ? (
                <EmptyHint depth={1}>
                  <Trans>No context files yet.</Trans>
                </EmptyHint>
              ) : null}
            </div>
          </TreeEnvProvider>
        ) : null}
      </AreaDropRegion>
    </section>
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
