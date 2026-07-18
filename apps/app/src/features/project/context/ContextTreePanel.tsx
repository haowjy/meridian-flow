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
 * (folders/sections toggle, files open). Project-scoped sections stack above a
 * work-boundary divider; work-scoped sections (Work Memory, Uploads) below it.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, FilePlus, FolderPlus } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "./ContextEntryActions";
import { TreeChildren, type TreeEnv, TreeEnvProvider } from "./ContextTreeRows";
import type { ContextCreateKind } from "./context-create-kind";
import { schemeIcon, schemeLabel, visibleContextSchemes } from "./context-schemes";
import { type ContextFile, findContextFile } from "./context-tree";
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
 * Sections fetch lazily — `useProjectContextTree` only runs once open — and the
 * section containing the active file auto-opens.
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
  const firstWorkScoped = schemes.find(isWorkScopedProjectContextScheme) ?? null;
  const workLabel = works?.find((work) => work.id === workId)?.title ?? t`Work`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto overflow-x-hidden pb-2">
      {schemes.map((scheme) => (
        <Fragment key={scheme}>
          {scheme === firstWorkScoped ? <WorkBoundary label={workLabel} /> : null}
          <SchemeSection
            projectId={projectId}
            activeThreadId={activeThreadId}
            scheme={scheme}
            activeScheme={activeScheme}
            activePath={activePath}
            defaultExpanded={scheme === schemes[0]}
            onSelectFile={onSelectFile}
            creating={
              creating?.scheme === scheme
                ? { kind: creating.kind, parentPath: creating.parentPath }
                : null
            }
            onRequestCreate={(kind, parentPath) => onRequestCreate({ scheme, kind, parentPath })}
            onCreateDone={onCreateDone}
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Hairline divider with a centered inset label naming the active work. Marks
 * the boundary below which sections are work-scoped (Work Memory, Uploads). The
 * label is a hover affordance for a future work switcher.
 */
function WorkBoundary({ label }: { label: string }) {
  return (
    <div className="relative mx-3 my-2 h-px shrink-0 bg-border-subtle">
      <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 whitespace-nowrap bg-sidebar px-1.5 leading-none">
        <span
          title={t`Switch work`}
          className="cursor-default rounded-sm px-0.5 text-meta text-muted-foreground transition-colors hover:bg-sidebar-accent hover:font-medium hover:text-foreground"
        >
          {label}
        </span>
      </span>
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
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onCreateDone: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const owns = activeLocationPath !== null;
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
  const isOpen = expanded || owns || creating !== null || pendingOpenPath !== null;

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
    if (activeLocationPath) revealPath(parentContextPath(activeLocationPath));
  }, [activeLocationPath, revealPath]);

  useEffect(() => {
    if (creating) revealPath(creating.parentPath);
  }, [creating, revealPath]);

  const requestCreate = useCallback(
    (kind: ContextCreateKind, parentPath: string) => {
      setExpanded(true);
      revealPath(parentPath);
      onRequestCreate(kind, parentPath);
    },
    [onRequestCreate, revealPath],
  );

  const togglePath = useCallback(
    (path: string, defaultOpen: boolean) => {
      if (
        creating &&
        (creating.parentPath === path || creating.parentPath.startsWith(`${path}/`))
      ) {
        return;
      }
      setExpandedPaths((current) => ({ ...current, [path]: !(current[path] ?? defaultOpen) }));
    },
    [creating],
  );

  const { tree, isError, isFetching, refetch } = useProjectContextTree(projectId, scheme, {
    enabled: isOpen,
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

  return (
    <section>
      <TreeSectionHeader
        label={schemeLabel(scheme)}
        icon={schemeIcon(scheme)}
        expanded={isOpen}
        onToggle={() => {
          if (!creating) setExpanded((previous) => !previous);
        }}
        onNewFile={() => requestCreate("file", "")}
        onNewFolder={() => requestCreate("folder", "")}
      />
      {isOpen ? (
        <TreeEnvProvider value={env}>
          <div>
            <TreeChildren parentPath="" children={tree?.children ?? []} depth={1} />
            {isError ? (
              <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
            ) : !tree ? (
              isFetching ? (
                <TreeLoadingSkeleton />
              ) : creating?.parentPath !== "" ? (
                <EmptyHint>
                  <Trans>No context files yet.</Trans>
                </EmptyHint>
              ) : null
            ) : tree.children.length === 0 && !creating ? (
              <EmptyHint>
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

/**
 * Section disclosure header: a full-row disclosure control with sibling create
 * actions, so every interactive element has independent keyboard semantics.
 */
function TreeSectionHeader({
  label,
  icon: Icon,
  expanded,
  onToggle,
  onNewFile,
  onNewFolder,
}: {
  label: string;
  /** Scheme identity icon — contexts are sources, not folders. */
  icon: LucideIcon;
  expanded: boolean;
  onToggle: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  return (
    <div className="group relative flex h-7 items-center hover:bg-sidebar-accent">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="focus-ring flex h-7 min-w-0 flex-1 items-center rounded-none pr-1 pl-1 text-left"
      >
        <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <ChevronRight
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </span>
        <Icon aria-hidden className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs tracking-wide text-muted-foreground">
          {label}
        </span>
      </button>
      {/* Absolutely positioned so the (idle-hidden) actions never steal label
          width; on hover they sit over the label's end on the row's own tint. */}
      <span className="absolute top-1/2 right-1 flex shrink-0 -translate-y-1/2 items-center gap-0.5 rounded bg-sidebar-accent pl-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <SectionActionButton icon={FilePlus} label={t`New file`} onClick={onNewFile} />
        <SectionActionButton icon={FolderPlus} label={t`New folder`} onClick={onNewFolder} />
      </span>
    </div>
  );
}

function SectionActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof FilePlus;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      // hover:bg-sidebar-accent (not bg-muted): the shelf-safe hover grammar —
      // page-recess tints read light-on-light against the shelf's own tones.
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-1.5 pr-2 text-xs text-ink-subtle" style={{ paddingLeft: rowPaddingLeft(1) }}>
      {children}
    </p>
  );
}

/** Placeholder rows echoing the tree's row geometry while files load. */
function TreeLoadingSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">
        <Trans>Loading files…</Trans>
      </span>
      <div aria-hidden>
        {["w-24", "w-32", "w-20"].map((width) => (
          <div
            key={width}
            className="flex h-7 items-center pr-2"
            style={{ paddingLeft: rowPaddingLeft(1) }}
          >
            <Skeleton className={cn("h-3", width)} />
          </div>
        ))}
      </div>
    </div>
  );
}
