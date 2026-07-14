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
import { Fragment, useState } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useWorks } from "@/client/query/useWorks";
import { cn } from "@/lib/utils";
import {
  DeleteConfirmationDialog,
  type EntryActionTarget,
  useDeleteConfirmation,
} from "../context/ContextEntryActions";
import type { ContextCreateKind } from "../context/context-create-kind";
import { fileKindIcon } from "../context/context-file-icon";
import { schemeIcon, schemeLabel, visibleContextSchemes } from "../context/context-schemes";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { type ContextDir, type ContextFile, findContextDir } from "../context/context-tree";
import { useCreateEntryForm } from "../context/use-create-entry-form";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import type { ProjectViewProps } from "../ProjectView";
import { MobileEntryActionsMenu } from "./MobileEntryActionsMenu";

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
                    icon={
                      <SchemeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    }
                    label={schemeLabel(scheme)}
                    trailing={
                      <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                    }
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

  // Resolve the current folder's sibling names for collision detection. When
  // the tree isn't loaded yet (or the folder URL is stale), fall back to an
  // empty list — the server still rejects duplicates, this just gives live
  // client-side feedback matching the desktop tree panel.
  const currentDir = tree ? findContextDir(tree, folder ?? "") : null;
  const siblingNames = currentDir ? currentDir.children.map((child) => child.name) : [];

  const deleteConfirm = useDeleteConfirmation({ projectId, activeThreadId, scheme });

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
          siblingNames={siblingNames}
          onDone={onCreateDone}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FolderListingBody
          tree={tree}
          isError={isError}
          isFetching={isFetching}
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          folder={folder}
          workId={workId}
          onSelectContextFolder={onSelectContextFolder}
          onSelectContextPath={onSelectContextPath}
          onRequestDelete={deleteConfirm.requestDelete}
        />
      </div>
      <DeleteConfirmationDialog
        target={deleteConfirm.target}
        isPending={deleteConfirm.isPending}
        onCancel={deleteConfirm.cancel}
        onConfirm={deleteConfirm.confirm}
      />
    </div>
  );
}

function FolderListingBody({
  tree,
  isError,
  isFetching,
  projectId,
  activeThreadId,
  scheme,
  folder,
  workId,
  onSelectContextFolder,
  onSelectContextPath,
  onRequestDelete,
}: {
  tree: ContextDir | null;
  isError: boolean;
  isFetching: boolean;
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  folder: string | null;
  workId: string | null;
  onSelectContextFolder: MobileContextBrowserProps["onSelectContextFolder"];
  onSelectContextPath: MobileContextBrowserProps["onSelectContextPath"];
  onRequestDelete: (target: EntryActionTarget) => void;
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

  const siblingNames = dir.children.map((c) => c.name);

  return (
    <ul className="flex flex-col">
      {folders.map((child) => (
        <MobileFolderRow
          key={child.path}
          dir={child}
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          siblingNames={siblingNames}
          onDrill={() => onSelectContextFolder(child.path)}
          onRequestDelete={onRequestDelete}
        />
      ))}
      {files.map((child) => (
        <MobileFileRow
          key={child.path}
          file={child}
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          siblingNames={siblingNames}
          onOpen={() => openFile(child)}
          onRequestDelete={onRequestDelete}
        />
      ))}
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
  siblingNames,
  onDone,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  /** Parent folder path (`""` for the scheme root). */
  parent: string;
  kind: ContextCreateKind;
  /** Names of siblings in the current folder, for live collision detection. */
  siblingNames: readonly string[];
  onDone: () => void;
}) {
  const form = useCreateEntryForm({
    projectId,
    activeThreadId,
    scheme,
    kind,
    parent,
    siblingNames,
    onDone,
  });
  const Icon = form.icon;

  return (
    <div className="shrink-0 border-b border-border-subtle bg-sidebar-accent/30">
      <div className="flex min-h-10 items-center gap-2.5 px-4">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
      {form.severity ? (
        <div
          className={cn(
            "px-4 pb-2 text-meta",
            form.severity.level === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {form.severity.message}
        </div>
      ) : null}
    </div>
  );
}

/** Folder row with trailing `...` actions. Supports inline rename. */
function MobileFolderRow({
  dir,
  projectId,
  activeThreadId,
  scheme,
  siblingNames,
  onDrill,
  onRequestDelete,
}: {
  dir: ContextDir;
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  siblingNames: readonly string[];
  onDrill: () => void;
  onRequestDelete: (target: EntryActionTarget) => void;
}) {
  const [renaming, setRenaming] = useState(false);

  if (renaming) {
    return (
      <li>
        <MobileRenameRow
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          path={dir.path}
          currentName={dir.name}
          siblingNames={siblingNames}
          icon={Folder}
          onDone={() => setRenaming(false)}
        />
      </li>
    );
  }

  return (
    <li>
      <DrillRow
        icon={<Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        label={dir.name}
        trailing={
          <MobileEntryActionsMenu
            onAction={(action) => {
              if (action === "rename") setRenaming(true);
              else onRequestDelete({ name: dir.name, path: dir.path, kind: "dir" });
            }}
          />
        }
        onClick={onDrill}
      />
    </li>
  );
}

/** File row with trailing `...` actions. Supports inline rename. */
function MobileFileRow({
  file,
  projectId,
  activeThreadId,
  scheme,
  siblingNames,
  onOpen,
  onRequestDelete,
}: {
  file: ContextFile;
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  siblingNames: readonly string[];
  onOpen: () => void;
  onRequestDelete: (target: EntryActionTarget) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const FileIcon = fileKindIcon(file);

  if (renaming) {
    return (
      <li>
        <MobileRenameRow
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          path={file.path}
          currentName={file.name}
          siblingNames={siblingNames}
          icon={FileIcon}
          onDone={() => setRenaming(false)}
        />
      </li>
    );
  }

  return (
    <li>
      <DrillRow
        icon={<FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        label={file.name}
        trailing={
          <MobileEntryActionsMenu
            onAction={(action) => {
              if (action === "rename") setRenaming(true);
              else onRequestDelete({ name: file.name, path: file.path, kind: "file" });
            }}
          />
        }
        onClick={onOpen}
      />
    </li>
  );
}

/** Mobile inline rename row — replaces the DrillRow while renaming. */
function MobileRenameRow({
  projectId,
  activeThreadId,
  scheme,
  path,
  currentName,
  siblingNames,
  icon: Icon,
  onDone,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  path: string;
  currentName: string;
  siblingNames: readonly string[];
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    activeThreadId,
    scheme,
    path,
    currentName,
    siblingNames,
    onDone,
  });

  return (
    <div className="shrink-0 border-b border-border-subtle bg-sidebar-accent/30">
      <div className="flex min-h-10 items-center gap-2.5 px-4">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={form.inputRef}
          type="text"
          value={form.name}
          onChange={form.onChange}
          onKeyDown={form.onKeyDown}
          onBlur={form.onBlur}
          aria-label={t`Rename`}
          disabled={form.isPending}
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="focus-ring my-1.5 w-full min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-base text-foreground outline-none disabled:opacity-60"
        />
      </div>
      {form.severity ? (
        <div
          className={cn(
            "px-4 pb-2 text-meta",
            form.severity.level === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {form.severity.message}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Section label between project-scoped and work-scoped schemes in the root
 * list. iOS-style section header: muted label with spacing above, no
 * hairline — the DrillRow borders already separate items, so a centered
 * hairline (the desktop treatment) would double-line against them.
 */
function MobileWorkBoundary({ label }: { label: string }) {
  return (
    <li aria-hidden className="px-4 pt-3 pb-1">
      <span className="text-meta text-muted-foreground">{label}</span>
    </li>
  );
}

/**
 * Full-width tappable row. Borderless — matches the desktop tree's clean
 * visual language. Touch feedback via `active:bg-sidebar-accent`.
 *
 * `trailing` renders after the label: either a chevron for drill-in scheme
 * rows, or an action button for file/folder rows with rename/delete.
 */
function DrillRow({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <div className="flex min-h-10 w-full items-center text-left text-sm text-foreground transition-colors active:bg-sidebar-accent">
      <button
        type="button"
        onClick={onClick}
        className="focus-ring flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-4"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {trailing ? <span className="shrink-0 pr-2">{trailing}</span> : null}
    </div>
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
