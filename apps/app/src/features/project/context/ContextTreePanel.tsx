// @ts-nocheck
/**
 * ContextTreePanel — desktop context tree for navigating schemes, folders, and
 * files, rendered as a collapsible panel inside ContextViewer. Body owns tree
 * expansion / rename / create affordances while the route owns the selected
 * document path. (The phone shell uses MobileContextBrowser's drill-in
 * navigation instead.)
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronRight, FileText, Folder, FolderOpen, PanelLeftClose } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useContextTabsActions } from "@/client/stores";
import { cn } from "@/lib/utils";

import { PanelToggleButton } from "../shell/PanelToggleButton";
import { SidebarSectionLabel } from "../shell/SidebarSectionLabel";
import { CreateContextEntryMenu } from "./CreateContextEntryMenu";
import type { ContextCreateKind } from "./context-create-kind";
import { invalidContextEntryNameReason, joinContextEntryPath } from "./context-entry-name";
import { CONTEXT_SCHEMES, schemeLabel } from "./context-schemes";
import { type ContextDir, type ContextFile, findContextFile } from "./context-tree";

export type ContextTreePanelProps = {
  projectId: string;
  /** Scheme of the currently active file (drives section auto-expand). */
  activeScheme: ProjectContextTreeScheme | null;
  /** Path of the currently active file inside `activeScheme`'s tree. */
  activePath: string | null;
  /** Called when the user picks a file row in any scheme section. */
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  /** Collapse the files panel. */
  onCollapse: () => void;
};

/**
 * VS Code-style multi-scheme file tree. Each context scheme (`kb`, `user`,
 * `work`) renders as a collapsible top-level section with its own per-section
 * `+` menu. Sections fetch lazily — `useProjectContextTree` only runs once
 * open — and the section containing the active file auto-opens.
 *
 * Each section's `+` creates inside that section's scheme (so an empty
 * `user` or `work` is reachable from the section header directly). The
 * focus folder is the parent of the active path when the active file
 * belongs to this section, otherwise the scheme root.
 */
export function ContextTreePanel({
  projectId,
  activeScheme,
  activePath,
  onSelectFile,
  onCollapse,
}: ContextTreePanelProps) {
  const [creating, setCreating] = useState<{
    kind: ContextCreateKind;
    scheme: ProjectContextTreeScheme;
    parent: string;
  } | null>(null);

  // Where a new entry lands inside a given section: parent dir of the
  // active file when this section owns it, else the scheme root.
  function focusFolderFor(scheme: ProjectContextTreeScheme): string {
    if (activeScheme !== scheme || !activePath) return "";
    const segments = activePath.split("/").filter(Boolean);
    segments.pop();
    return segments.length === 0 ? "" : `/${segments.join("/")}`;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Own header: collapse (far-left) · "Files" label — mirrors the
          left sidebar's wordmark row so the collapse and reopen controls
          share the same x ("click without moving the cursor"). */}
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <PanelToggleButton icon={PanelLeftClose} label={t`Collapse files`} onClick={onCollapse} />
        <SidebarSectionLabel>
          <Trans>Files</Trans>
        </SidebarSectionLabel>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2">
        <ul className="flex flex-col">
          {CONTEXT_SCHEMES.map((scheme, index) => (
            <SchemeSection
              key={scheme}
              projectId={projectId}
              scheme={scheme}
              activeScheme={activeScheme}
              activePath={activePath}
              defaultExpanded={index === 0}
              onSelectFile={onSelectFile}
              creating={creating && creating.scheme === scheme ? creating : null}
              onRequestCreate={(kind) =>
                setCreating({ kind, scheme, parent: focusFolderFor(scheme) })
              }
              onCreateDone={() => setCreating(null)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SchemeSection({
  projectId,
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
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  defaultExpanded: boolean;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  creating: { kind: ContextCreateKind; parent: string } | null;
  onRequestCreate: (kind: ContextCreateKind) => void;
  onCreateDone: () => void;
}) {
  // The user-controlled toggle. `isOpen` derives from it plus the cases
  // where the section MUST be visible (it owns the active file or has an
  // open create row).
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const activeLocationPath = activeScheme === scheme ? activePath : null;
  const owns = activeLocationPath !== null;
  // Path of a just-created file we want to open as a tab once the tree
  // refetch (triggered by the create mutation's cache invalidation) lands.
  // Cleared in the resolve-effect below. This is the local replacement for
  // the old URL-deep-link round-trip — no browser URL involved.
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(null);
  const isOpen = expanded || owns || creating !== null || pendingOpenPath !== null;

  const { tree, isError, isFetching } = useProjectContextTree(projectId, scheme, {
    enabled: isOpen,
  });

  // Resolve the newly-created file once the refetched tree has it, and open
  // it as a tab. If the path doesn't resolve (delete race, rename), we drop
  // the pending request — silently surfacing as "no tab opened" is honest
  // because the file is no longer there to open.
  const { openTab } = useContextTabsActions();
  useEffect(() => {
    if (!pendingOpenPath || !tree) return;
    const file = findContextFile(tree, pendingOpenPath);
    if (!file) {
      setPendingOpenPath(null);
      return;
    }
    openTab(projectId, {
      documentId: file.documentId,
      scheme,
      path: file.path,
      name: file.name,
      ...(file.editable
        ? {
            editable: true as const,
            filetype: file.filetype,
            schemaType: file.schemaType,
          }
        : {
            editable: false as const,
            fileType: file.fileType,
            mimeType: file.mimeType,
          }),
    });
    setPendingOpenPath(null);
  }, [pendingOpenPath, tree, openTab, projectId, scheme]);

  const Chevron = ChevronRight;
  const label = schemeLabel(scheme);

  return (
    <li>
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          aria-label={t`Toggle ${label}`}
          aria-expanded={isOpen}
          onClick={() => setExpanded((prev) => !prev)}
          className="focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <Chevron
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
        <CreateContextEntryMenu onSelect={onRequestCreate} />
      </div>
      {isOpen ? (
        <div className="pb-1">
          {creating ? (
            <CreateRow
              projectId={projectId}
              scheme={scheme}
              parent={creating.parent}
              kind={creating.kind}
              onDone={onCreateDone}
              onCreatedFilePath={(path) => setPendingOpenPath(path)}
            />
          ) : null}
          {isError ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              <Trans>Could not load files.</Trans>
            </div>
          ) : !tree ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {isFetching ? <Trans>Loading files…</Trans> : <Trans>No context files yet.</Trans>}
            </div>
          ) : tree.children.length === 0 && !creating ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              <Trans>No context files yet.</Trans>
            </div>
          ) : (
            <TreeBlock
              dir={tree}
              depth={1}
              scheme={scheme}
              activeScheme={activeScheme}
              activePath={activePath}
              activeLocationPath={activeLocationPath}
              onSelectFile={onSelectFile}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}

function TreeBlock({
  dir,
  depth,
  scheme,
  activeScheme,
  activePath,
  activeLocationPath,
  onSelectFile,
}: {
  dir: ContextDir;
  depth: number;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  activeLocationPath: string | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
}) {
  return (
    <ul className="flex flex-col">
      {dir.children.map((child) =>
        child.kind === "dir" ? (
          <DirRow
            key={child.path}
            dir={child}
            depth={depth}
            scheme={scheme}
            activeScheme={activeScheme}
            activePath={activePath}
            activeLocationPath={activeLocationPath}
            onSelectFile={onSelectFile}
          />
        ) : (
          <FileRow
            key={child.path}
            file={child}
            depth={depth}
            scheme={scheme}
            active={scheme === activeScheme && child.path === activePath}
            onSelect={onSelectFile}
          />
        ),
      )}
    </ul>
  );
}

function DirRow({
  dir,
  depth,
  scheme,
  activeScheme,
  activePath,
  activeLocationPath,
  onSelectFile,
}: {
  dir: ContextDir;
  depth: number;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  activeLocationPath: string | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
}) {
  const ownsActive =
    scheme === activeScheme &&
    (activeLocationPath === dir.path || (activeLocationPath?.startsWith(`${dir.path}/`) ?? false));
  const startsExpanded = depth < 2 || ownsActive;
  const [expanded, setExpanded] = useState(startsExpanded);

  useEffect(() => {
    if (ownsActive) setExpanded(true);
  }, [ownsActive]);

  const Icon = expanded ? FolderOpen : Folder;
  const indent = depth * 14;

  return (
    <li>
      <button
        type="button"
        aria-label={t`Toggle folder ${dir.name}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="focus-ring flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-ink-muted transition-colors hover:bg-sidebar-accent hover:text-foreground"
        style={{ paddingLeft: 8 + indent }}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <Icon aria-hidden className="size-3.5 shrink-0 text-primary/80" />
        <span className="min-w-0 flex-1 truncate">{dir.name}</span>
      </button>
      {expanded ? (
        <TreeBlock
          dir={dir}
          depth={depth + 1}
          scheme={scheme}
          activeScheme={activeScheme}
          activePath={activePath}
          activeLocationPath={activeLocationPath}
          onSelectFile={onSelectFile}
        />
      ) : null}
    </li>
  );
}

function FileRow({
  file,
  depth,
  scheme,
  active,
  onSelect,
}: {
  file: ContextFile;
  depth: number;
  scheme: ProjectContextTreeScheme;
  active: boolean;
  onSelect: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
}) {
  const indent = depth * 14;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(scheme, file)}
        className={cn(
          "focus-ring flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors",
          active
            ? "bg-primary/10 font-medium text-foreground"
            : "text-ink-muted hover:bg-sidebar-accent hover:text-foreground",
        )}
        style={{ paddingLeft: 22 + indent }}
      >
        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
      </button>
    </li>
  );
}

/**
 * Desktop inline naming row. Pinned at the top of the active section while
 * editing. Same submit semantics as the mobile create row: Enter commits,
 * Escape / empty-blur cancels.
 */
function CreateRow({
  projectId,
  scheme,
  parent,
  kind,
  onDone,
  onCreatedFilePath,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  parent: string;
  kind: ContextCreateKind;
  onDone: () => void;
  /**
   * Notifies the section that a new file was created at this path so it can
   * open it as a tab once the tree refetch lands. Folders don't trigger this.
   */
  onCreatedFilePath: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const mutation = useCreateContextEntry(projectId, scheme);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      onDone();
      return;
    }
    const invalidReason = invalidContextEntryNameReason(trimmed);
    if (invalidReason) {
      setError(invalidReason);
      return;
    }
    const path = joinContextEntryPath(parent, trimmed);
    try {
      await mutation.mutateAsync({ type: kind, path });
      if (kind === "file") onCreatedFilePath(path);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const Icon = kind === "folder" ? Folder : FileText;
  const placeholder = kind === "folder" ? t`Folder name` : t`File name`;

  return (
    <div className="mx-2 mb-1 flex flex-col gap-1 rounded-md bg-sidebar-accent/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            kind === "folder" ? "text-primary/80" : "text-muted-foreground",
          )}
        />
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelledRef.current = true;
              onDone();
            }
          }}
          onBlur={() => {
            if (cancelledRef.current) return;
            void submit();
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={mutation.isPending}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="focus-ring w-full min-w-0 rounded-sm border border-input bg-background px-1.5 py-0.5 text-base text-foreground outline-none disabled:opacity-60 md:text-sm"
        />
      </div>
      {error ? <div className="px-1 text-fine text-destructive">{error}</div> : null}
    </div>
  );
}
