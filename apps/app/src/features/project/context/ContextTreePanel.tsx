/**
 * ContextTreePanel — desktop context tree for navigating schemes, folders, and
 * files, rendered persistently inside the desktop project sidebar. The body
 * owns tree expansion / create affordances while the route owns the selected
 * document path. (The phone shell uses MobileContextBrowser's drill-in navigation.)
 *
 * Visual model (VS Code parity): one continuous flex-column that is the panel's
 * single scroll surface — every section and row is natural-height, so blank
 * space pools at the very bottom and only the tree root scrolls. Rows are a
 * fixed twistie + kind-icon + label grid; the whole row is the primary action
 * (folders/sections toggle, files open). Every top-level section is a
 * `RailPaneHeader` pane (headers are panes; everything inside a pane is tree
 * rows), all flush full-width siblings in scheme order. Pane rhythm and labels,
 * rather than stacked surface colors or repeated rules, separate them. The work-scoped
 * schemes (Scratch, Uploads) included. There is no work header row (ruling
 * 2026-08-06 "just get rid of it", superseding the work-title-as-marking
 * model): the work marks itself via a tooltip on its panes' headers instead.
 * Creation lives on the scheme panes.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { FilePlus, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "./ContextEntryActions";
import { TreeChildren, type TreeEnv, TreeEnvProvider } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import {
  schemeAllowsCreation,
  schemeIcon,
  schemeLabel,
  visibleContextSchemes,
} from "./context-schemes";
import { type ContextFile, findContextFile } from "./context-tree";
import { PaneHeaderActionButton, RailPaneHeader } from "./RailPaneHeader";
import { type TreeCreationRequest, useOptionalTreeCreation } from "./TreeCreationProvider";

/** Left pad (px) for a row at `depth` — depth 1 = a section's direct child. */
function rowPaddingLeft(depth: number): number {
  return 8 + depth * 16;
}

export type ContextTreePanelProps = {
  projectId: string;
  /** Active chat thread — used to resolve work-scoped context browse `workId`. */
  activeThreadId: string | null;
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
  activeThreadId,
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
  const workId = useContextWorkId(projectId, activeThreadId);
  const schemes = visibleContextSchemes(workId);
  const { works } = useWorks(projectId);
  const currentWork = works?.find((work) => work.id === workId) ?? null;

  // The work-scoped panes passively follow the active chat's work (Jimmy's
  // 2026-08-03 ruling) — switching threads is the only way the rail
  // re-points. Work-scoped schemes only exist while a thread (and thus a
  // work) is active; `workName` puts the work's name in those panes' hover
  // tooltip, the rail's only work marking (ruling 2026-08-06).
  const renderScheme = (scheme: ProjectContextTreeScheme) => (
    <SchemeSection
      key={scheme}
      projectId={projectId}
      activeThreadId={activeThreadId}
      scheme={scheme}
      activeScheme={activeScheme}
      activePath={activePath}
      defaultExpanded={scheme === schemes[0]}
      workName={
        isWorkScopedProjectContextScheme(scheme) ? (currentWork?.name ?? t`Loading Work`) : null
      }
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2">
        {schemes.map(renderScheme)}
      </div>
    </div>
  );
}

function SchemeSection({
  projectId,
  activeThreadId,
  scheme,
  activeScheme,
  activePath,
  defaultExpanded,
  workName,
  onSelectFile,
  creating,
  onRequestCreate,
  onCreateDone,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  defaultExpanded: boolean;
  /**
   * Name of the work this pane belongs to, or null for project-scoped panes.
   * Shown in the header's hover tooltip — since the work header row died
   * (ruling 2026-08-06), this tooltip is how a work-scoped pane names its
   * work.
   */
  workName: string | null;
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
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);

  const revealPath = useCallback((path: string) => {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return;
    setExpandedPaths((current) => {
      const next = { ...current };
      let ancestor = "";
      for (const segment of segments) {
        ancestor += `/${segment}`;
        next[ancestor] = true;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeLocationPath) return;
    setExpanded(true);
    revealPath(parentContextPath(activeLocationPath));
  }, [activeLocationPath, revealPath]);

  useEffect(() => {
    if (!creating) return;
    setExpanded(true);
    revealPath(creating.parentPath);
  }, [creating, revealPath]);

  const requestCreate = useCallback(
    (kind: ContextCreateKind, parentPath: string) => {
      setExpanded(true);
      revealPath(parentPath);
      onRequestCreate(kind, parentPath);
    },
    [onRequestCreate, revealPath],
  );

  const togglePath = useCallback((path: string, defaultOpen: boolean) => {
    setExpandedPaths((current) => ({ ...current, [path]: !(current[path] ?? defaultOpen) }));
  }, []);

  // The query is unconditionally enabled: it prefetches at rail mount so the
  // first expand paints from cache (work-scoped schemes still wait for their
  // workId inside the hook). `pendingOpenPath` waits on the same always-live
  // query so a just-created file can resolve and open; its onSelectFile then
  // lands a new selection here, which re-expands via the effect above.
  const { tree, isError, refetch } = useProjectContextTree(projectId, scheme, {
    activeThreadId,
  });
  useEffect(() => {
    if (!pendingOpenPath || !tree) return;
    const file = findContextFile(tree, pendingOpenPath);
    if (!file) return;
    onSelectFile(scheme, file);
    setPendingOpenPath(null);
  }, [pendingOpenPath, tree, onSelectFile, scheme]);

  const deleteConfirm = useDeleteConfirmation({ projectId, activeThreadId, scheme });
  const env = useMemo<TreeEnv>(
    () => ({
      projectId,
      activeThreadId,
      scheme,
      activeScheme,
      activePath,
      creating,
      onSelectFile,
      onRequestCreate: requestCreate,
      onRequestDelete: deleteConfirm.requestDelete,
      onCreateDone,
      onCreatedFilePath: setPendingOpenPath,
      isExpanded: (path, depth) => expandedPaths[path] ?? depth < 2,
      togglePath,
    }),
    [
      projectId,
      activeThreadId,
      scheme,
      activeScheme,
      activePath,
      creating,
      onSelectFile,
      requestCreate,
      deleteConfirm.requestDelete,
      onCreateDone,
      expandedPaths,
      togglePath,
    ],
  );

  const handleExpandedChange = (next: boolean) => {
    if (creating) onCreateDone();
    setExpanded(next);
  };

  /* Work-scoped panes (Scratch, Uploads) share this header untouched: flush
     full-width bands like their project-scoped siblings. Uploads carries no
     create shelf (`schemeAllowsCreation`): it is intake only, so its one
     action is Upload file. */
  const header = (
    <RailPaneHeader
      label={schemeLabel(scheme)}
      icon={schemeIcon(scheme)}
      ariaLabel={
        workName === null
          ? undefined
          : scheme === "scratch"
            ? t`Scratch for Work ${workName}`
            : t`Uploads for Work ${workName}`
      }
      expanded={expanded}
      onExpandedChange={handleExpandedChange}
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
    <section>
      {workName === null ? (
        header
      ) : (
        /* The work names itself here: with the work header row gone (ruling
           2026-08-06), hovering or focusing a work-scoped pane header is how
           the writer learns which work these files belong to. Plain-div
           trigger: `RailPaneHeader` owns its root element and does not
           forward refs/props, and Radix's default trigger is a <button>
           (invalid around the header's own collapse button). The div adds no
           box of its own; hover anywhere on the row (React focus events
           bubble from the inner button) opens the tooltip without touching
           collapse or the action shelf. */
        <Tooltip>
          <TooltipTrigger asChild>
            <div>{header}</div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={4}>
            <Trans>Work: "{workName}"</Trans>
          </TooltipContent>
        </Tooltip>
      )}
      {expanded ? (
        <TreeEnvProvider value={env}>
          <div>
            <TreeChildren parentPath="" children={tree?.children ?? []} depth={1} />
            {/* "No context files yet." is a claim about the tree, so it waits
                for a RESOLVED tree. While the query is in flight with nothing
                cached the pane body stays blank (no spinner) — prefetch at
                mount makes that window nearly unhittable. */}
            {isError ? (
              <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
            ) : tree && tree.children.length === 0 && !creating ? (
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
        onCancel={deleteConfirm.cancel}
        onConfirm={deleteConfirm.confirm}
      />
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
