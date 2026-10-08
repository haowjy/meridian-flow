/** Direct-child rows and inline actions for one context catalog scheme. */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import type {
  CatalogContextView,
  CatalogFile as ContextFile,
  CatalogNode as ContextNode,
} from "@/client/query/context-catalog-projection";
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
import { contextTreeRowClassName, contextTreeRowGrowClassName } from "./context-row-geometry";
import { schemeAllowsCreation } from "./context-schemes";
import { EntryNameField } from "./EntryNameField";
import { LinkUpdateNote } from "./LinkUpdateNote";
import { NamespaceFailureMark } from "./NamespaceFailureMark";
import { useCreateEntryForm } from "./use-create-entry-form";
import { useRenameEntryForm } from "./use-rename-entry-form";
import { useRepairOnFreshFailure } from "./use-repair-on-fresh-failure";

/**
 * Stable per-scheme identity and commands. Rows read only this context, so a
 * selection, expansion or catalog refresh never re-renders every row through
 * it; the panel keeps these callbacks referentially stable.
 */
export type TreeActions = {
  projectId: string;
  workId: string | null;
  scheme: ProjectContextTreeScheme;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onRequestDelete: (target: EntryActionTarget) => void;
  onCreateDone: () => void;
  onCreatedFilePath: (path: string) => void;
  /** Also ends an open create form, as a folder toggle always has. */
  toggleEntry: (entryId: string, defaultOpen: boolean) => void;
};

/** Volatile tree state. Only `TreeChildren` reads it and hands rows plain props. */
export type TreeView = {
  /** Active file path in this scheme, or null when the active file is elsewhere. */
  activePath: string | null;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  isExpanded: (entryId: string, depth: number) => boolean;
  catalog: CatalogContextView;
};

const TreeActionsContext = createContext<TreeActions | null>(null);
const TreeViewContext = createContext<TreeView | null>(null);

export function TreeEnvProvider({
  actions,
  view,
  children,
}: {
  actions: TreeActions;
  view: TreeView;
  children: ReactNode;
}) {
  return (
    <TreeActionsContext.Provider value={actions}>
      <TreeViewContext.Provider value={view}>{children}</TreeViewContext.Provider>
    </TreeActionsContext.Provider>
  );
}

function useTreeActions(): TreeActions {
  const actions = useContext(TreeActionsContext);
  if (!actions) throw new Error("Tree rows require a scheme environment");
  return actions;
}

function useTreeView(): TreeView {
  const view = useContext(TreeViewContext);
  if (!view) throw new Error("Tree rows require a scheme environment");
  return view;
}

/** The sole child renderer; root and nested folders mount creation identically. */
export function TreeChildren({
  parentId,
  parentPath,
  depth,
}: {
  parentId: string;
  parentPath: string;
  depth: number;
}) {
  const view = useTreeView();
  const children = view.catalog.children(parentId);
  const siblingNames = useSiblingNames(children);
  return (
    <>
      {view.creating?.parentPath === parentPath ? (
        <CreateRow
          kind={view.creating.kind}
          parent={parentPath}
          depth={depth}
          siblingNames={siblingNames}
        />
      ) : null}
      {children.map((child) =>
        child.kind === "dir" ? (
          <DirRow
            key={child.entryId}
            dir={child}
            depth={depth}
            siblingNames={siblingNames}
            isOpen={view.isExpanded(child.entryId, depth)}
          />
        ) : (
          <FileRow
            key={child.entryId}
            file={child}
            depth={depth}
            siblingNames={siblingNames}
            active={child.path === view.activePath}
          />
        ),
      )}
    </>
  );
}

/** Keeps the sibling-name array stable while the names are unchanged, so memoized rows hold. */
function useSiblingNames(children: readonly ContextNode[]): readonly string[] {
  const key = children.map((child) => child.name).join("\u0000");
  return useMemo(() => (key === "" ? [] : key.split("\u0000")), [key]);
}

/**
 * Catalog projections rebuild node objects on every resource update, so rows
 * compare the node's fields rather than its identity.
 */
function sameNode(left: ContextNode, right: ContextNode): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as (keyof ContextNode)[];
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => {
    const a: unknown = left[key];
    const b: unknown = right[key];
    if (Array.isArray(a) && Array.isArray(b))
      return a.length === b.length && a.every((value, index) => value === b[index]);
    return a === b;
  });
}

function rowPaddingLeft(depth: number): number {
  return depth * 16;
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

type DirRowProps = {
  dir: Extract<ContextNode, { kind: "dir" }>;
  depth: number;
  siblingNames: readonly string[];
  isOpen: boolean;
};

const DirRow = memo(
  function DirRow({ dir, depth, siblingNames, isOpen }: DirRowProps) {
    const env = useTreeActions();
    const [renaming, setRenaming] = useState(false);
    const [noteOperationId, setNoteOperationId] = useState<string | null>(null);
    // A refused rename offers its name field once, as the failure arrives.
    useRepairOnFreshFailure(dir.namespaceFailureAt, () => setRenaming(true));
    const toggle = () => env.toggleEntry(dir.entryId, depth < 2);

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
          entryId={dir.entryId}
          path={dir.path}
          currentName={dir.name}
          repairName={dir.namespaceRepairName}
          siblingNames={siblingNames}
          kind="folder"
          depth={depth}
          icon={isOpen ? FolderOpen : Folder}
          onRenamed={setNoteOperationId}
          onDone={() => setRenaming(false)}
        />
      );
    }

    const allowCreate = schemeAllowsCreation(env.scheme);
    const allowDelete = env.scheme !== "uploads";
    return (
      <>
        <ContextEntryMenu
          allowCreate={allowCreate}
          allowDelete={allowDelete}
          onAction={handleAction}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
          <div
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            aria-label={t`Toggle folder ${dir.name}`}
            onClick={toggle}
            onKeyDown={activateOnKey(toggle)}
            className={cn(
              "group focus-ring mx-2 flex items-center rounded-md pr-1 text-sm text-foreground hover:bg-sidebar-accent/50",
              contextTreeRowGrowClassName,
            )}
            style={{ paddingLeft: rowPaddingLeft(depth) }}
          >
            <Twistie expanded={isOpen} />
            <RowIcon icon={isOpen ? FolderOpen : Folder} />
            <span className="ml-0.5 flex min-w-0 flex-1 flex-col justify-center">
              <span className="truncate">{dir.name}</span>
              <LinkUpdateNote
                projectId={env.projectId}
                subject={{ kind: "folder", id: dir.entryId }}
                operationId={noteOperationId}
                layout="stacked"
              />
            </span>
            {dir.namespaceFailure ? (
              <NamespaceFailureMark failure={dir.namespaceFailure} folder />
            ) : null}
            <EntryKebabButton
              allowCreate={allowCreate}
              allowDelete={allowDelete}
              onAction={handleAction}
            />
          </div>
        </ContextEntryMenu>
        {isOpen ? (
          <TreeChildren parentId={dir.entryId} parentPath={dir.path} depth={depth + 1} />
        ) : null}
      </>
    );
  },
  (prev, next) =>
    prev.isOpen === next.isOpen &&
    prev.depth === next.depth &&
    prev.siblingNames === next.siblingNames &&
    sameNode(prev.dir, next.dir),
);

type FileRowProps = {
  file: ContextFile;
  depth: number;
  siblingNames: readonly string[];
  active: boolean;
};

const FileRow = memo(
  function FileRow({ file, depth, siblingNames, active }: FileRowProps) {
    const env = useTreeActions();
    const [renaming, setRenaming] = useState(false);
    const [noteOperationId, setNoteOperationId] = useState<string | null>(null);
    const select = () => env.onSelectFile(env.scheme, file);
    useRepairOnFreshFailure(file.namespaceFailureAt, () => setRenaming(true));

    function handleAction(action: EntryAction) {
      const parentPath = parentContextEntryPath(file.path);
      if (action === "new-file") env.onRequestCreate("file", parentPath);
      else if (action === "new-folder") env.onRequestCreate("folder", parentPath);
      else if (action === "rename") setRenaming(true);
      else if (action === "delete")
        env.onRequestDelete({
          name: file.name,
          path: file.path,
          kind: "file",
          documentId: file.documentId,
        });
    }

    if (renaming) {
      return (
        <RenameRow
          entryId={file.documentId}
          path={file.path}
          currentName={file.name}
          repairName={file.namespaceRepairName}
          siblingNames={siblingNames}
          kind="file"
          depth={depth}
          icon={fileKindIcon(file)}
          onRenamed={setNoteOperationId}
          onDone={() => setRenaming(false)}
        />
      );
    }

    const allowCreate = schemeAllowsCreation(env.scheme);
    const allowDelete = env.scheme !== "uploads";
    return (
      <ContextEntryMenu allowCreate={allowCreate} allowDelete={allowDelete} onAction={handleAction}>
        {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
        <div
          role="button"
          tabIndex={0}
          onClick={select}
          onKeyDown={activateOnKey(select)}
          className={cn(
            "group focus-ring mx-2 flex items-center rounded-md pr-1 text-sm",
            contextTreeRowGrowClassName,
            /* Hover is inactive-only: the active row retains its stronger fill. */
            active
              ? "bg-sidebar-accent font-medium text-foreground"
              : "text-foreground hover:bg-sidebar-accent/50",
          )}
          style={{ paddingLeft: rowPaddingLeft(depth) }}
        >
          <span className="h-7 w-4 shrink-0" aria-hidden />
          <RowIcon icon={fileKindIcon(file)} />
          <span className="ml-0.5 flex min-w-0 flex-1 flex-col justify-center">
            <span className="truncate">{file.name}</span>
            <LinkUpdateNote
              projectId={env.projectId}
              subject={{ kind: "file", id: file.documentId }}
              operationId={noteOperationId}
              layout="stacked"
            />
          </span>
          {file.namespaceFailure ? <NamespaceFailureMark failure={file.namespaceFailure} /> : null}
          <EntryKebabButton
            allowCreate={allowCreate}
            allowDelete={allowDelete}
            onAction={handleAction}
          />
        </div>
      </ContextEntryMenu>
    );
  },
  (prev, next) =>
    prev.active === next.active &&
    prev.depth === next.depth &&
    prev.siblingNames === next.siblingNames &&
    sameNode(prev.file, next.file),
);

function RenameRow({
  entryId,
  path,
  currentName,
  repairName,
  siblingNames,
  kind,
  depth,
  icon,
  onRenamed,
  onDone,
}: {
  entryId: string;
  path: string;
  currentName: string;
  repairName?: string;
  siblingNames: readonly string[];
  kind: ContextCreateKind;
  depth: number;
  icon: typeof Folder;
  onRenamed: (operationId: string) => void;
  onDone: () => void;
}) {
  const env = useTreeActions();
  const form = useRenameEntryForm({
    projectId: env.projectId,
    workId: env.workId,
    scheme: env.scheme,
    entryId,
    path,
    currentName,
    repairName,
    siblingNames,
    kind,
    onRenamed,
    onDone,
  });
  return (
    <div
      className={cn("mx-2 flex items-center pr-1 text-sm text-foreground", contextTreeRowClassName)}
      style={{ paddingLeft: rowPaddingLeft(depth) }}
    >
      <span className="h-7 w-4 shrink-0" aria-hidden />
      <RowIcon icon={icon} />
      <EntryNameField form={form} label={t`Rename`} className="ml-0.5" />
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
  const env = useTreeActions();
  const form = useCreateEntryForm({
    projectId: env.projectId,
    scheme: env.scheme,
    kind,
    parent,
    siblingNames,
    onDone: env.onCreateDone,
    onCreated: kind === "file" ? env.onCreatedFilePath : undefined,
  });
  return (
    <div
      className={cn("mx-2 flex items-center pr-1 text-sm text-foreground", contextTreeRowClassName)}
      style={{ paddingLeft: rowPaddingLeft(depth) }}
    >
      <span className="h-7 w-4 shrink-0" aria-hidden />
      <RowIcon icon={form.icon} />
      <EntryNameField
        form={form}
        label={form.placeholder}
        placeholder={form.placeholder}
        className="ml-0.5"
      />
    </div>
  );
}
