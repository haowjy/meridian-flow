/** Recursive rows and inline actions for one context-tree scheme. */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { createContext, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
import { cn } from "@/lib/utils";
import {
  ContextEntryMenu,
  type EntryAction,
  type EntryActionTarget,
  EntryKebabButton,
} from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import type { ContextFile, ContextNode } from "./context-tree";
import { InlineValidationOverlay } from "./InlineValidationOverlay";
import { useCreateEntryForm } from "./use-create-entry-form";
import { useRenameEntryForm } from "./use-rename-entry-form";

export type TreeEnv = {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onRequestDelete: (target: EntryActionTarget) => void;
  onCreateDone: () => void;
  onCreatedFilePath: (path: string) => void;
  isExpanded: (path: string, depth: number) => boolean;
  togglePath: (path: string, defaultOpen: boolean) => void;
};

const TreeEnvContext = createContext<TreeEnv | null>(null);

export function TreeEnvProvider({ value, children }: { value: TreeEnv; children: ReactNode }) {
  return <TreeEnvContext.Provider value={value}>{children}</TreeEnvContext.Provider>;
}

function useTreeEnv(): TreeEnv {
  const env = useContext(TreeEnvContext);
  if (!env) throw new Error("Tree rows require a scheme environment");
  return env;
}

/** The sole child renderer; root and nested folders mount creation identically. */
export function TreeChildren({
  parentPath,
  children,
  depth,
}: {
  parentPath: string;
  children: readonly ContextNode[];
  depth: number;
}) {
  const env = useTreeEnv();
  const siblingNames = children.map((child) => child.name);
  return (
    <>
      {env.creating?.parentPath === parentPath ? (
        <CreateRow
          kind={env.creating.kind}
          parent={parentPath}
          depth={depth}
          siblingNames={siblingNames}
        />
      ) : null}
      {children.map((child) =>
        child.kind === "dir" ? (
          <DirRow key={child.path} dir={child} depth={depth} siblingNames={siblingNames} />
        ) : (
          <FileRow key={child.path} file={child} depth={depth} siblingNames={siblingNames} />
        ),
      )}
    </>
  );
}

function rowPaddingLeft(depth: number): number {
  return 8 + depth * 16;
}

function activateOnKey(handler: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler();
    }
  };
}

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
  siblingNames,
}: {
  dir: Extract<ContextNode, { kind: "dir" }>;
  depth: number;
  siblingNames: readonly string[];
}) {
  const env = useTreeEnv();
  const [renaming, setRenaming] = useState(false);
  const isOpen = env.isExpanded(dir.path, depth);
  const toggle = () => {
    if (env.creating) env.onCreateDone();
    env.togglePath(dir.path, depth < 2);
  };

  function handleAction(action: EntryAction) {
    if (action === "new-file") env.onRequestCreate("file", dir.path);
    else if (action === "new-folder") env.onRequestCreate("folder", dir.path);
    else if (action === "rename") setRenaming(true);
    else if (action === "delete")
      env.onRequestDelete({ name: dir.name, path: dir.path, kind: "dir" });
  }

  if (renaming) {
    return (
      <RenameRow
        path={dir.path}
        currentName={dir.name}
        siblingNames={siblingNames}
        kind="folder"
        depth={depth}
        icon={isOpen ? FolderOpen : Folder}
        onDone={() => setRenaming(false)}
      />
    );
  }

  return (
    <>
      <ContextEntryMenu onAction={handleAction}>
        {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          aria-label={t`Toggle folder ${dir.name}`}
          onClick={toggle}
          onKeyDown={activateOnKey(toggle)}
          className="group focus-ring flex h-7 cursor-pointer items-center pr-1 text-sm text-foreground hover:bg-sidebar-accent"
          style={{ paddingLeft: rowPaddingLeft(depth) }}
        >
          <Twistie expanded={isOpen} />
          <RowIcon icon={isOpen ? FolderOpen : Folder} />
          <span className="ml-0.5 min-w-0 flex-1 truncate">{dir.name}</span>
          <EntryKebabButton onAction={handleAction} />
        </div>
      </ContextEntryMenu>
      {isOpen ? (
        <TreeChildren parentPath={dir.path} children={dir.children} depth={depth + 1} />
      ) : null}
    </>
  );
}

function FileRow({
  file,
  depth,
  siblingNames,
}: {
  file: ContextFile;
  depth: number;
  siblingNames: readonly string[];
}) {
  const env = useTreeEnv();
  const [renaming, setRenaming] = useState(false);
  const select = () => env.onSelectFile(env.scheme, file);

  function handleAction(action: EntryAction) {
    const parentPath = parentContextEntryPath(file.path);
    if (action === "new-file") env.onRequestCreate("file", parentPath);
    else if (action === "new-folder") env.onRequestCreate("folder", parentPath);
    else if (action === "rename") setRenaming(true);
    else if (action === "delete")
      env.onRequestDelete({ name: file.name, path: file.path, kind: "file" });
  }

  if (renaming) {
    return (
      <RenameRow
        path={file.path}
        currentName={file.name}
        siblingNames={siblingNames}
        kind="file"
        depth={depth}
        icon={fileKindIcon(file)}
        onDone={() => setRenaming(false)}
      />
    );
  }

  const active = env.scheme === env.activeScheme && file.path === env.activePath;
  return (
    <ContextEntryMenu onAction={handleAction}>
      {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={select}
        onKeyDown={activateOnKey(select)}
        className={cn(
          "group focus-ring flex h-7 cursor-pointer items-center pr-1 text-sm hover:bg-sidebar-accent",
          active ? "bg-sidebar-accent font-medium text-foreground" : "text-foreground",
        )}
        style={{ paddingLeft: rowPaddingLeft(depth) }}
      >
        <span className="h-7 w-4 shrink-0" aria-hidden />
        <RowIcon icon={fileKindIcon(file)} />
        <span className="ml-0.5 min-w-0 flex-1 truncate">{file.name}</span>
        <EntryKebabButton onAction={handleAction} />
      </div>
    </ContextEntryMenu>
  );
}

function RenameRow({
  path,
  currentName,
  siblingNames,
  kind,
  depth,
  icon,
  onDone,
}: {
  path: string;
  currentName: string;
  siblingNames: readonly string[];
  kind: ContextCreateKind;
  depth: number;
  icon: typeof Folder;
  onDone: () => void;
}) {
  const env = useTreeEnv();
  const form = useRenameEntryForm({
    projectId: env.projectId,
    activeThreadId: env.activeThreadId,
    scheme: env.scheme,
    path,
    currentName,
    siblingNames,
    kind,
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
          className="focus-ring h-[22px] w-full min-w-0 rounded-sm border border-border bg-sidebar-accent px-1 text-base text-foreground outline-none disabled:opacity-60 md:text-sm"
        />
        <InlineValidationOverlay anchorRef={form.inputRef} severity={form.severity} />
      </div>
    </div>
  );
}

function CreateRow({
  kind,
  parent,
  depth,
  siblingNames,
}: {
  kind: ContextCreateKind;
  parent: string;
  depth: number;
  siblingNames: readonly string[];
}) {
  const env = useTreeEnv();
  const form = useCreateEntryForm({
    projectId: env.projectId,
    activeThreadId: env.activeThreadId,
    scheme: env.scheme,
    kind,
    parent,
    siblingNames,
    onDone: env.onCreateDone,
    onCreated: kind === "file" ? env.onCreatedFilePath : undefined,
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
          className="focus-ring h-[22px] w-full min-w-0 rounded-sm border border-border bg-sidebar-accent px-1 text-base text-foreground outline-none disabled:opacity-60 md:text-sm"
        />
        <InlineValidationOverlay anchorRef={form.inputRef} severity={form.severity} />
      </div>
    </div>
  );
}
