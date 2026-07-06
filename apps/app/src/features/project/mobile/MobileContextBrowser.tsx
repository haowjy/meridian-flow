/**
 * MobileContextBrowser — drill-in phone Files surface.
 *
 * Replaces the desktop expand/collapse tree with one-folder-per-screen
 * navigation. The root level is a pure context-source list — the context
 * schemes (KB / User / Work / Project Workspace, mirroring the desktop tree panel's
 * section order); Results live on their own full-screen view
 * (`MobileResultsView`, `?results=`), not here. Entering a scheme or
 * folder is driven entirely by the route's `scheme`/`folder` params, so
 * OS/browser back pops levels naturally and the top-bar breadcrumb stays in
 * sync. Data comes from the
 * same `useProjectContextTree` query the desktop tree panel uses — the
 * client tree is already fully loaded per scheme, so drilling is pure lookup
 * (`findContextDir`), not refetching.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { AlertCircle, ChevronRight, Folder, Loader2 } from "lucide-react";
import { Fragment } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useWorks } from "@/client/query/useWorks";
import { cn } from "@/lib/utils";
import type { ContextCreateKind } from "../context/context-create-kind";
import { fileKindIcon } from "../context/context-file-icon";
import { schemeIcon, schemeLabel, visibleContextSchemes } from "../context/context-schemes";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { type ContextDir, type ContextFile, findContextDir } from "../context/context-tree";
import { useCreateEntryForm } from "../context/use-create-entry-form";
import type { ProjectViewProps } from "../ProjectView";

export type MobileContextBrowserProps = Pick<
  ProjectViewProps,
  | "projectId"
  | "activeThreadId"
  | "activeContextScheme"
  | "activeContextFolder"
  | "onSelectContextScheme"
  | "onSelectContextFolder"
  | "onSelectContextPath"
> & {
  /**
   * Pending inline create row, or null. Owned by MobileProject because the
   * `+` entry point is top-bar chrome; the location is always the current
   * scheme+folder from the route ("create where you are").
   */
  creating: ContextCreateKind | null;
  /** Closes the create row (after commit, cancel, or empty blur). */
  onCreateDone: () => void;
};

export function MobileContextBrowser({
  projectId,
  activeThreadId,
  activeContextScheme,
  activeContextFolder,
  onSelectContextScheme,
  onSelectContextFolder,
  onSelectContextPath,
  creating,
  onCreateDone,
}: MobileContextBrowserProps) {
  const workId = useContextWorkId(projectId, activeThreadId);
  const schemes = visibleContextSchemes(workId);
  const { works } = useWorks(projectId);

  if (activeContextScheme) {
    return (
      <MobileFolderListing
        projectId={projectId}
        activeThreadId={activeThreadId}
        scheme={activeContextScheme}
        folder={activeContextFolder}
        onSelectContextFolder={onSelectContextFolder}
        onSelectContextPath={onSelectContextPath}
        creating={creating}
        onCreateDone={onCreateDone}
      />
    );
  }

  const firstWorkScoped = schemes.find(isWorkScopedProjectContextScheme) ?? null;
  const workLabel = works?.find((work) => work.id === workId)?.title ?? t`Work`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="flex flex-col">
          {schemes.map((scheme) => {
            // Schemes are context sources, not folders — each carries its
            // identity icon; folder icons are reserved for real directories.
            const SchemeIcon = schemeIcon(scheme);
            return (
              <Fragment key={scheme}>
                {scheme === firstWorkScoped ? <MobileWorkBoundary label={workLabel} /> : null}
                <li>
                  <DrillRow
                    icon={<SchemeIcon aria-hidden className="size-4 shrink-0 text-primary/80" />}
                    label={schemeLabel(scheme)}
                    drillsIn
                    onClick={() => onSelectContextScheme(scheme)}
                  />
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * One folder level of a scheme's tree: folders first, then files, preserving
 * the server's order within each kind. Folder taps drill in via the route;
 * file taps open the document.
 */
function MobileFolderListing({
  projectId,
  activeThreadId,
  scheme,
  folder,
  onSelectContextFolder,
  onSelectContextPath,
  creating,
  onCreateDone,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  /** Current folder path (`/a/b`) or null for the scheme root. */
  folder: string | null;
  onSelectContextFolder: MobileContextBrowserProps["onSelectContextFolder"];
  onSelectContextPath: MobileContextBrowserProps["onSelectContextPath"];
  creating: ContextCreateKind | null;
  onCreateDone: () => void;
}) {
  const workId = useContextWorkId(projectId, activeThreadId);
  const { tree, isError, isFetching } = useProjectContextTree(projectId, scheme, {
    activeThreadId,
  });

  // The create row pins above the scroll area (iOS Files style) so it stays
  // visible regardless of listing scroll position — and, with the on-screen
  // keyboard up, it sits just under the top bar, far from the keyboard.
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {creating ? (
        <MobileCreateRow
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          parent={folder ?? ""}
          kind={creating}
          onDone={onCreateDone}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FolderListingBody
          tree={tree}
          isError={isError}
          isFetching={isFetching}
          scheme={scheme}
          folder={folder}
          workId={workId}
          onSelectContextFolder={onSelectContextFolder}
          onSelectContextPath={onSelectContextPath}
        />
      </div>
    </div>
  );
}

function FolderListingBody({
  tree,
  isError,
  isFetching,
  scheme,
  folder,
  workId,
  onSelectContextFolder,
  onSelectContextPath,
}: {
  tree: ContextDir | null;
  isError: boolean;
  isFetching: boolean;
  scheme: ProjectContextTreeScheme;
  folder: string | null;
  workId: string | null;
  onSelectContextFolder: MobileContextBrowserProps["onSelectContextFolder"];
  onSelectContextPath: MobileContextBrowserProps["onSelectContextPath"];
}) {
  if (isError) {
    return (
      <ListingStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Could not load files.</Trans>
      </ListingStatus>
    );
  }
  if (!tree) {
    return (
      <ListingStatus tone="muted">
        {isFetching ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <Trans>Loading files…</Trans>
          </>
        ) : (
          <Trans>No context files yet.</Trans>
        )}
      </ListingStatus>
    );
  }

  const dir = findContextDir(tree, folder ?? "");
  if (!dir) {
    // Stale URL (folder renamed/deleted out from under the route) — honest
    // dead-end; the breadcrumb/back chevron still leads out.
    return (
      <ListingStatus tone="muted">
        <Trans>This folder no longer exists.</Trans>
      </ListingStatus>
    );
  }

  const folders = dir.children.filter((child): child is ContextDir => child.kind === "dir");
  const files = dir.children.filter((child): child is ContextFile => child.kind === "file");

  if (folders.length === 0 && files.length === 0) {
    return (
      <ListingStatus tone="muted">
        <Trans>This folder is empty.</Trans>
      </ListingStatus>
    );
  }

  function openFile(file: ContextFile) {
    const contextTab = contextTabFromFile(scheme, file, workId);
    onSelectContextPath(contextTab.path, contextTab.scheme);
  }

  return (
    <ul className="flex flex-col">
      {folders.map((child) => (
        <li key={child.path}>
          <DrillRow
            icon={<Folder aria-hidden className="size-4 shrink-0 text-primary/80" />}
            label={child.name}
            drillsIn
            onClick={() => onSelectContextFolder(child.path)}
          />
        </li>
      ))}
      {files.map((child) => {
        const FileIcon = fileKindIcon(child.name);
        return (
          <li key={child.path}>
            <DrillRow
              icon={<FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
              label={child.name}
              onClick={() => openFile(child)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Phone inline naming row, pinned above the folder listing (iOS Files style).
 * State machine lives in useCreateEntryForm; this component owns only the
 * phone chrome (44px touch targets, 16px text to prevent iOS zoom, inline
 * error below input instead of portal overlay).
 */
function MobileCreateRow({
  projectId,
  activeThreadId,
  scheme,
  parent,
  kind,
  onDone,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  /** Parent folder path (`""` for the scheme root). */
  parent: string;
  kind: ContextCreateKind;
  onDone: () => void;
}) {
  const form = useCreateEntryForm({ projectId, activeThreadId, scheme, kind, parent, onDone });
  const Icon = form.icon;

  return (
    <div className="shrink-0 border-b border-border-subtle bg-sidebar-accent/40">
      <div className="flex min-h-11 items-center gap-3 px-4">
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            kind === "folder" ? "text-primary/80" : "text-muted-foreground",
          )}
        />
        <input
          ref={form.inputRef}
          type="text"
          value={form.name}
          onChange={form.onChange}
          onKeyDown={form.onKeyDown}
          onBlur={form.onBlur}
          placeholder={form.placeholder}
          aria-label={form.placeholder}
          disabled={form.isPending}
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          // text-base = 16px: iOS Safari zooms the page when focusing inputs
          // below 16px, which would fight the locked phone shell.
          className="focus-ring my-1.5 w-full min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-base text-foreground outline-none disabled:opacity-60"
        />
      </div>
      {form.severity?.level === "error" ? (
        <div className="px-4 pb-2 text-meta text-destructive">{form.severity.message}</div>
      ) : null}
    </div>
  );
}

/**
 * Thin divider between project-scoped and work-scoped schemes in the root
 * list, mirroring the desktop tree's `WorkBoundary`. Labels with the active
 * work's title.
 */
function MobileWorkBoundary({ label }: { label: string }) {
  return (
    <li aria-hidden className="relative mx-4 my-1.5 h-px shrink-0 bg-border-subtle">
      <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 whitespace-nowrap bg-background px-1.5 leading-none">
        <span className="text-meta text-muted-foreground">{label}</span>
      </span>
    </li>
  );
}

/** Full-width tappable list row; `drillsIn` adds the trailing chevron. */
function DrillRow({
  icon,
  label,
  drillsIn = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  drillsIn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex min-h-11 w-full items-center gap-3 border-b border-border-subtle px-4 text-left text-sm text-foreground transition-colors active:bg-sidebar-accent"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {drillsIn ? <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-subtle" /> : null}
    </button>
  );
}

function ListingStatus({ children, tone }: { children: React.ReactNode; tone: "muted" | "error" }) {
  return (
    <div
      className={cn(
        "grid h-full place-items-center px-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
