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
import { ChevronRight, FilePlus, Folder, FolderOpen, FolderPlus } from "lucide-react";
import { Fragment, type KeyboardEvent, useEffect, useState } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { cn } from "@/lib/utils";
import {
  ContextEntryMenu,
  DeleteConfirmationDialog,
  type EntryAction,
  type EntryActionTarget,
  EntryKebabButton,
  useDeleteConfirmation,
} from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import { fileKindIcon } from "./context-file-icon";
import { schemeLabel, visibleContextSchemes } from "./context-schemes";
import { type ContextDir, type ContextFile, findContextFile } from "./context-tree";
import { InlineValidationOverlay } from "./InlineValidationOverlay";
import { useCreateEntryForm } from "./use-create-entry-form";
import { useRenameEntryForm } from "./use-rename-entry-form";

/** Left pad (px) for a row at `depth` — depth 1 = a section's direct child. */
function rowPaddingLeft(depth: number): number {
  return 8 + depth * 16;
}

/** Enter/Space activate a `role="button"` row (full-row primary action). */
function activateOnKey(handler: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler();
    }
  };
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
  /** Entry currently being named, shared with actions outside the tree. */
  creating: {
    kind: ContextCreateKind;
    scheme: ProjectContextTreeScheme;
  } | null;
  /** Start an inline create row in a scheme. */
  onRequestCreate: (scheme: ProjectContextTreeScheme, kind: ContextCreateKind) => void;
  /** Close the active inline create row after commit or cancellation. */
  onCreateDone: () => void;
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
  creating,
  onRequestCreate,
  onCreateDone,
}: ContextTreePanelProps) {
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
            creating={creating?.scheme === scheme ? creating.kind : null}
            onRequestCreate={(kind) => onRequestCreate(scheme, kind)}
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
  creating: ContextCreateKind | null;
  onRequestCreate: (kind: ContextCreateKind) => void;
  onCreateDone: () => void;
}) {
  // The user-controlled toggle. `isOpen` derives from it plus the cases where
  // the section MUST be visible (owns the active file / has an open create row).
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const owns = activeLocationPath !== null;
  // Path of a just-created file we want to open as a tab once the tree refetch
  // (triggered by the create mutation's cache invalidation) lands. Cleared in
  // the resolve-effect below — the local replacement for the old URL round-trip.
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
  const isOpen = expanded || owns || creating !== null || pendingOpenPath !== null;

  const { tree, isError, isFetching, refetch } = useProjectContextTree(projectId, scheme, {
    enabled: isOpen,
    activeThreadId,
  });
  // Resolve the newly-created file once the refetched tree has it, then follow
  // the same tab + route path as a tree-row click. The first effect after the
  // mutation may still see the stale cached tree, so keep waiting if absent.
  useEffect(() => {
    if (!pendingOpenPath || !tree) return;
    const file = findContextFile(tree, pendingOpenPath);
    if (!file) return;
    onSelectFile(scheme, file);
    setPendingOpenPath(null);
  }, [pendingOpenPath, tree, onSelectFile, scheme]);

  const rootSiblingNames = tree ? tree.children.map((child) => child.name) : [];
  const deleteConfirm = useDeleteConfirmation({ projectId, activeThreadId, scheme });

  return (
    <section>
      <TreeSectionHeader
        label={schemeLabel(scheme)}
        expanded={isOpen}
        onToggle={() => setExpanded((prev) => !prev)}
        onNewFile={() => onRequestCreate("file")}
        onNewFolder={() => onRequestCreate("folder")}
      />
      {isOpen ? (
        <div>
          {creating ? (
            <CreateRow
              projectId={projectId}
              activeThreadId={activeThreadId}
              scheme={scheme}
              kind={creating}
              depth={1}
              siblingNames={rootSiblingNames}
              onDone={onCreateDone}
              onCreatedFilePath={setPendingOpenPath}
            />
          ) : null}
          {isError ? (
            <InlineErrorRow message={t`Couldn't load files.`} onRetry={refetch} />
          ) : !tree ? (
            <EmptyHint>
              {isFetching ? <Trans>Loading files…</Trans> : <Trans>No context files yet.</Trans>}
            </EmptyHint>
          ) : tree.children.length === 0 && !creating ? (
            <EmptyHint>
              <Trans>No context files yet.</Trans>
            </EmptyHint>
          ) : (
            <TreeBlock
              dir={tree}
              depth={1}
              projectId={projectId}
              activeThreadId={activeThreadId}
              scheme={scheme}
              activeScheme={activeScheme}
              activePath={activePath}
              activeLocationPath={activeLocationPath}
              onSelectFile={onSelectFile}
              onRequestDelete={deleteConfirm.requestDelete}
            />
          )}
        </div>
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

/**
 * Section disclosure header: full-row toggle with a muted label and hover-
 * revealed "New file / New folder" actions. The row is the toggle; the action
 * buttons stop propagation so they don't also toggle the section.
 */
function TreeSectionHeader({
  label,
  expanded,
  onToggle,
  onNewFile,
  onNewFolder,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: full-row toggle nests the hover New file/New folder buttons; a native <button> can't nest them.
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={activateOnKey(onToggle)}
      className="group focus-ring relative flex h-7 cursor-pointer items-center pr-1 pl-1 hover:bg-sidebar-accent"
    >
      <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
        <ChevronRight
          aria-hidden
          className={cn("size-3 transition-transform", expanded && "rotate-90")}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs tracking-wide text-muted-foreground">
        {label}
      </span>
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
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-subtle hover:text-foreground"
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

function TreeBlock({
  dir,
  depth,
  projectId,
  activeThreadId,
  scheme,
  activeScheme,
  activePath,
  activeLocationPath,
  onSelectFile,
  onRequestDelete,
}: {
  dir: ContextDir;
  depth: number;
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  activeLocationPath: string | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestDelete: (target: EntryActionTarget) => void;
}) {
  const siblingNames = dir.children.map((child) => child.name);
  return (
    <>
      {dir.children.map((child) =>
        child.kind === "dir" ? (
          <DirRow
            key={child.path}
            dir={child}
            depth={depth}
            projectId={projectId}
            activeThreadId={activeThreadId}
            scheme={scheme}
            activeScheme={activeScheme}
            activePath={activePath}
            activeLocationPath={activeLocationPath}
            siblingNames={siblingNames}
            onSelectFile={onSelectFile}
            onRequestDelete={onRequestDelete}
          />
        ) : (
          <FileRow
            key={child.path}
            file={child}
            depth={depth}
            projectId={projectId}
            activeThreadId={activeThreadId}
            scheme={scheme}
            active={scheme === activeScheme && child.path === activePath}
            siblingNames={siblingNames}
            onSelect={onSelectFile}
            onRequestDelete={onRequestDelete}
          />
        ),
      )}
    </>
  );
}

/** Fixed-width twistie cell (16px) — chevron for folders/sections. */
function Twistie({ expanded }: { expanded: boolean }) {
  return (
    <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
      <ChevronRight
        aria-hidden
        className={cn("size-3 transition-transform", expanded && "rotate-90")}
      />
    </span>
  );
}

/** Fixed-width kind-icon cell (16px) — mono, muted. */
function RowIcon({ icon: Icon }: { icon: typeof Folder }) {
  return (
    <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

function DirRow({
  dir,
  depth,
  projectId,
  activeThreadId,
  scheme,
  activeScheme,
  activePath,
  activeLocationPath,
  siblingNames,
  onSelectFile,
  onRequestDelete,
}: {
  dir: ContextDir;
  depth: number;
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  activeLocationPath: string | null;
  siblingNames: readonly string[];
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestDelete: (target: EntryActionTarget) => void;
}) {
  const ownsActive =
    scheme === activeScheme &&
    (activeLocationPath === dir.path || (activeLocationPath?.startsWith(`${dir.path}/`) ?? false));
  const [expanded, setExpanded] = useState(depth < 2 || ownsActive);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (ownsActive) setExpanded(true);
  }, [ownsActive]);

  const toggle = () => setExpanded((prev) => !prev);

  function handleAction(action: EntryAction) {
    if (action === "rename") setRenaming(true);
    else if (action === "delete") onRequestDelete({ name: dir.name, path: dir.path, kind: "dir" });
  }

  if (renaming) {
    return (
      <RenameRow
        projectId={projectId}
        activeThreadId={activeThreadId}
        scheme={scheme}
        path={dir.path}
        currentName={dir.name}
        siblingNames={siblingNames}
        depth={depth}
        icon={expanded ? FolderOpen : Folder}
        onDone={() => setRenaming(false)}
      />
    );
  }

  return (
    <>
      <ContextEntryMenu onAction={handleAction}>
        {/* biome-ignore lint/a11y/useSemanticElements: full-row toggle that
            nests the hover kebab button; a native <button> can't nest one. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={t`Toggle folder ${dir.name}`}
          onClick={toggle}
          onKeyDown={activateOnKey(toggle)}
          className="group focus-ring flex h-7 cursor-pointer items-center pr-1 text-sm text-foreground hover:bg-sidebar-accent"
          style={{ paddingLeft: rowPaddingLeft(depth) }}
        >
          <Twistie expanded={expanded} />
          <RowIcon icon={expanded ? FolderOpen : Folder} />
          <span className="ml-0.5 min-w-0 flex-1 truncate">{dir.name}</span>
          <EntryKebabButton onAction={handleAction} />
        </div>
      </ContextEntryMenu>
      {expanded ? (
        <TreeBlock
          dir={dir}
          depth={depth + 1}
          projectId={projectId}
          activeThreadId={activeThreadId}
          scheme={scheme}
          activeScheme={activeScheme}
          activePath={activePath}
          activeLocationPath={activeLocationPath}
          onSelectFile={onSelectFile}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
    </>
  );
}

function FileRow({
  file,
  depth,
  projectId,
  activeThreadId,
  scheme,
  active,
  siblingNames,
  onSelect,
  onRequestDelete,
}: {
  file: ContextFile;
  depth: number;
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  active: boolean;
  siblingNames: readonly string[];
  onSelect: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestDelete: (target: EntryActionTarget) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const select = () => onSelect(scheme, file);

  function handleAction(action: EntryAction) {
    if (action === "rename") setRenaming(true);
    else if (action === "delete")
      onRequestDelete({ name: file.name, path: file.path, kind: "file" });
  }

  if (renaming) {
    return (
      <RenameRow
        projectId={projectId}
        activeThreadId={activeThreadId}
        scheme={scheme}
        path={file.path}
        currentName={file.name}
        siblingNames={siblingNames}
        depth={depth}
        icon={fileKindIcon(file.name)}
        onDone={() => setRenaming(false)}
      />
    );
  }

  return (
    <ContextEntryMenu onAction={handleAction}>
      {/* biome-ignore lint/a11y/useSemanticElements: full-row open target that
          nests the hover kebab button; a native <button> can't nest one. */}
      <div
        role="button"
        tabIndex={0}
        onClick={select}
        onKeyDown={activateOnKey(select)}
        className={cn(
          "group focus-ring flex h-7 cursor-pointer items-center pr-1 text-sm hover:bg-sidebar-accent",
          active ? "bg-primary/10 font-medium text-foreground" : "text-foreground",
        )}
        style={{ paddingLeft: rowPaddingLeft(depth) }}
      >
        {/* Empty twistie cell keeps files aligned under folder labels. */}
        <span className="h-7 w-4 shrink-0" aria-hidden />
        <RowIcon icon={fileKindIcon(file.name)} />
        <span className="ml-0.5 min-w-0 flex-1 truncate">{file.name}</span>
        <EntryKebabButton onAction={handleAction} />
      </div>
    </ContextEntryMenu>
  );
}

/** Inline rename row — replaces the normal row while renaming. */
function RenameRow({
  projectId,
  activeThreadId,
  scheme,
  path,
  currentName,
  siblingNames,
  depth,
  icon,
  onDone,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  path: string;
  currentName: string;
  siblingNames: readonly string[];
  depth: number;
  icon: typeof Folder;
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
    <div className="flex h-7 items-center pr-1" style={{ paddingLeft: rowPaddingLeft(depth) }}>
      <span className="h-7 w-4 shrink-0" aria-hidden />
      <RowIcon icon={icon} />
      <div className="relative ml-0.5 flex min-w-0 flex-1 items-center">
        <input
          ref={form.inputRef}
          type="text"
          value={form.name}
          onChange={form.onChange}
          onKeyDown={form.onKeyDown}
          onBlur={form.onBlur}
          aria-label={t`Rename`}
          disabled={form.isPending}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="focus-ring h-[22px] w-full min-w-0 rounded-sm border border-primary bg-background px-1 text-base text-foreground outline-none disabled:opacity-60 md:text-sm"
        />
        <InlineValidationOverlay anchorRef={form.inputRef} severity={form.severity} />
      </div>
    </div>
  );
}

/** Inline naming row — chrome only; state machine lives in useCreateEntryForm. */
function CreateRow({
  projectId,
  activeThreadId,
  scheme,
  kind,
  depth,
  siblingNames,
  onDone,
  onCreatedFilePath,
}: {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  kind: ContextCreateKind;
  depth: number;
  siblingNames: readonly string[];
  onDone: () => void;
  /** New file's path, so the section can open it as a tab post-refetch. */
  onCreatedFilePath: (path: string) => void;
}) {
  const form = useCreateEntryForm({
    projectId,
    activeThreadId,
    scheme,
    kind,
    siblingNames,
    onDone,
    onCreated: kind === "file" ? onCreatedFilePath : undefined,
  });

  return (
    <div className="flex h-7 items-center pr-1" style={{ paddingLeft: rowPaddingLeft(depth) }}>
      <span className="h-7 w-4 shrink-0" aria-hidden />
      <RowIcon icon={form.icon} />
      <div className="relative ml-0.5 flex min-w-0 flex-1 items-center">
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
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="focus-ring h-[22px] w-full min-w-0 rounded-sm border border-primary bg-background px-1 text-base text-foreground outline-none disabled:opacity-60 md:text-sm"
        />
        <InlineValidationOverlay anchorRef={form.inputRef} severity={form.severity} />
      </div>
    </div>
  );
}
