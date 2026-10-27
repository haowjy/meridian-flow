/** Direct-child rows and inline actions for one context catalog scheme. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronRight, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type {
  CatalogContextView,
  CatalogFile as ContextFile,
  CatalogNode as ContextNode,
} from "@/client/query/context-catalog-projection";
import { useToastRegistry } from "@/components/app/toast-registry";
import {
  type ImportedTree,
  type PendingRow,
  plainTree,
  rowId,
  siblingsOf,
} from "@/features/import/tree-rows";
import { cn } from "@/lib/utils";
import { type DeleteTarget, EntryKebabButton } from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import {
  contextTreeFileRowClassName,
  contextTreeRowClassName,
  contextTreeRowGrowClassName,
  contextTreeSelectedRowClassName,
} from "./context-row-geometry";
import { EntryNameField } from "./EntryNameField";
import { dragEntry } from "./entry-drag/entry";
import { useEntryRow } from "./entry-drag/use-entry-row";
import { LinkUpdateNote } from "./LinkUpdateNote";
import { NamespaceFailureMark } from "./NamespaceFailureMark";
import { DropRegion, InsertionLine } from "./tree-drop/DropRegion";
import { type TreeDropTarget, useTreeDropTarget } from "./tree-drop/tree-drop";
import { useCreateEntryForm } from "./use-create-entry-form";
import {
  type EntryCapabilities,
  type EntryCreation,
  EntryInteractionShell,
  useEntryInteraction,
} from "./use-entry-interaction";
import { useRenameEntryForm } from "./use-rename-entry-form";

export type TreeEnv = {
  projectId: string;
  owner: ContextOwner;
  capabilities: EntryCapabilities;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  creation?: {
    creating: { kind: ContextCreateKind; parentPath: string } | null;
    request: EntryCreation;
    done: () => void;
    createdFile: (path: string) => void;
  };
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestDelete: (target: DeleteTarget) => void;
  importHere?: {
    folders: boolean;
    start: (
      folder: { entryId: string; path: string; uri: string; name: string } | null,
      kind: "folder" | "files",
    ) => void;
  };
  isExpanded: (entryId: string) => boolean;
  toggleEntry: (entryId: string) => void;
  catalog: CatalogContextView;
  tree?: ImportedTree;
  visibleIds?: ReadonlySet<string>;
  rename?: { path: string; done: () => void };
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

/** A visible child group, which may span more than one catalog. */
export function TreeGroup({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="relative isolate">
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-y-1 z-10 border-l border-border-subtle"
        style={{ left: rowPaddingLeft(depth) }}
      />
    </div>
  );
}

/** The sole catalog child renderer; standalone lists start at depth zero. */
export function TreeChildren({
  parentId,
  parentPath,
  depth,
  parent = null,
}: {
  parentId: string;
  parentPath: string;
  depth: number;
  /** The folder these rows sit in; null at the area root. File rows drop into it. */
  parent?: DropFolder | null;
}) {
  const env = useTreeEnv();
  const tree = useMemo(() => env.tree ?? plainTree(env.catalog), [env.tree, env.catalog]);
  const children = tree.rows(parentId);
  const siblings = useMemo(() => siblingsOf(children), [children]);
  return (
    <>
      {env.creation?.creating?.parentPath === parentPath ? (
        <CreateRow
          kind={env.creation?.creating.kind}
          parent={parentPath}
          depth={depth}
          siblings={siblings}
        />
      ) : null}
      {children
        .filter(
          (child) =>
            child.origin === "import" || !env.visibleIds || env.visibleIds.has(child.node.entryId),
        )
        .map((child) =>
          child.origin === "import" ? (
            <PendingTreeRow key={child.id} row={child} depth={depth} />
          ) : child.node.kind === "dir" ? (
            <DirRow
              key={rowId(child)}
              dir={child.node}
              depth={depth}
              siblings={siblings}
              parent={parent}
            />
          ) : (
            <FileRow
              key={rowId(child)}
              file={child.node}
              depth={depth}
              siblings={siblings}
              parent={parent}
            />
          ),
        )}
    </>
  );
}

type DropFolder = NonNullable<TreeDropTarget["folder"]>;

/** The `mx-2` every row sits inside its region with. */
const ROW_INSET_PX = 8;

export function rowPaddingLeft(depth: number): number {
  return depth * 16;
}

function activateOnKey(handler: (event: KeyboardEvent) => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handler(event);
    }
  };
}

export function Twistie({ expanded }: { expanded: boolean }) {
  return (
    <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
      <ChevronRight
        aria-hidden
        className={cn("size-3 transition-transform", expanded && "rotate-90")}
      />
    </span>
  );
}

export function RowIcon({ icon: Icon }: { icon: typeof Folder }) {
  return (
    <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

// Edge bands, as a share of the row's height. A file's centre only re-files it
// into its own folder, so its edges get more room than a folder's, whose centre
// moves rows into it.
const FILE_EDGE_BAND = 1 / 3;
const FOLDER_EDGE_BAND = 1 / 4;

function DirRow({
  dir,
  depth,
  siblings,
  parent,
}: {
  dir: Extract<ContextNode, { kind: "dir" }>;
  depth: number;
  siblings: readonly ContextEntrySibling[];
  parent: DropFolder | null;
}) {
  const env = useTreeEnv();
  const folder: DropFolder = {
    entryId: dir.entryId,
    path: dir.path,
    uri: dir.uri,
    name: dir.name,
  };
  const interaction = useEntryInteraction({
    projectId: env.projectId,
    node: dir,
    owner: env.owner,
    scheme: env.scheme,
    capabilities: env.capabilities,
    create: env.creation?.request,
    onRequestDelete: env.onRequestDelete,
    importHere: env.importHere
      ? {
          folders: env.importHere.folders,
          start: (kind) => env.importHere?.start(folder, kind),
        }
      : undefined,
    siblings,
  });
  const isOpen = env.isExpanded(dir.entryId);
  // An open folder's bottom borders its first child, so "after" it is the next sibling's top edge.
  const drop = useTreeDropTarget(
    { scheme: env.scheme, catalogRootId: env.catalog.root.entryId, folder },
    {
      reveal: () => !env.isExpanded(dir.entryId) && env.toggleEntry(dir.entryId),
      edges: { folder: parent, siblingId: dir.entryId, band: FOLDER_EDGE_BAND, after: !isOpen },
    },
  );
  const movable = interaction.actions.includes("move");
  const entry = useMemo(() => dragEntry(dir, movable), [dir, movable]);
  const row = useEntryRow(entry, false);
  const toggle = () => {
    if (env.creation?.creating) env.creation.done();
    env.toggleEntry(dir.entryId);
  };
  if (interaction.renaming) {
    return (
      <RenameRow options={interaction.rename} depth={depth} icon={isOpen ? FolderOpen : Folder} />
    );
  }

  return (
    <DropRegion state={drop.dropState}>
      {/* The region spans the subtree, so "after" lands below everything shown inside. */}
      <InsertionLine edge={drop.edge} inset={ROW_INSET_PX + rowPaddingLeft(depth)} />
      <EntryInteractionShell interaction={interaction}>
        {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          aria-label={t`Toggle folder ${dir.name}`}
          onClick={row.activate(toggle)}
          onKeyDown={activateOnKey(row.activate(toggle))}
          {...row.rowProps}
          {...drop.dropProps}
          className={cn(
            "group focus-ring mx-2 flex items-center rounded-md pr-1 text-sm text-foreground",
            row.selected ? contextTreeSelectedRowClassName : "hover:bg-sidebar-accent/50",
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
              operationId={interaction.operationId}
              layout="stacked"
            />
          </span>
          {dir.namespaceFailure ? (
            <NamespaceFailureMark
              failure={dir.namespaceFailure}
              move={Boolean(dir.namespaceRepairMove)}
              folder
            />
          ) : null}
          <EntryKebabButton allowedActions={interaction.actions} onAction={interaction.onAction} />
        </div>
      </EntryInteractionShell>
      {isOpen ? (
        <TreeGroup depth={depth + 1}>
          <TreeChildren
            parentId={dir.entryId}
            parentPath={dir.path}
            depth={depth + 1}
            parent={folder}
          />
        </TreeGroup>
      ) : null}
    </DropRegion>
  );
}

/** A folder root shown while its import is still being built out of sight. */
function PendingTreeRow({ row, depth }: { row: PendingRow; depth: number }) {
  const registry = useToastRegistry();
  const element = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    element.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <button
      type="button"
      ref={element}
      data-import-root={row.id}
      onClick={() => registry.reveal(row.importId)}
      className={cn(
        "focus-ring mx-2 flex w-[calc(100%-1rem)] items-center rounded-md pr-2 text-left text-sm text-ink-muted hover:bg-sidebar-accent/50",
        contextTreeRowGrowClassName,
      )}
      style={{ paddingLeft: rowPaddingLeft(depth) }}
    >
      <span className="w-4 shrink-0" aria-hidden />
      <RowIcon icon={Folder} />
      <span className="ml-0.5 min-w-0 flex-1 truncate">{row.name}</span>
      <LoaderCircle
        aria-hidden
        className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
      />
      <span className="sr-only">
        <Trans>Import in progress. Show activity</Trans>
      </span>
    </button>
  );
}

function FileRow({
  file,
  depth,
  siblings,
  parent,
}: {
  file: ContextFile;
  depth: number;
  siblings: readonly ContextEntrySibling[];
  parent: DropFolder | null;
}) {
  const env = useTreeEnv();
  // A file is not a drop target of its own: its centre hands the drop to its folder (or the area).
  const drop = useTreeDropTarget(
    { scheme: env.scheme, catalogRootId: env.catalog.root.entryId, folder: parent },
    { edges: { folder: parent, siblingId: file.entryId, band: FILE_EDGE_BAND, after: true } },
  );
  const interaction = useEntryInteraction({
    projectId: env.projectId,
    node: file,
    requestRename: env.rename?.path === file.path,
    onRenameDone: env.rename?.done,
    owner: env.owner,
    scheme: env.scheme,
    capabilities: env.capabilities,
    create: env.creation?.request,
    onRequestDelete: env.onRequestDelete,
    siblings,
  });
  const select = () => env.onSelectFile(env.scheme, file);
  const active = env.scheme === env.activeScheme && file.path === env.activePath;
  const movable = interaction.actions.includes("move");
  const entry = useMemo(() => dragEntry(file, movable), [file, movable]);
  const row = useEntryRow(entry, active);
  if (interaction.renaming) {
    return <RenameRow options={interaction.rename} depth={depth} icon={fileKindIcon(file)} />;
  }

  return (
    <EntryInteractionShell interaction={interaction}>
      {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={row.activate(select)}
        onKeyDown={activateOnKey(row.activate(select))}
        {...row.rowProps}
        {...drop.dropProps}
        className={cn("focus-ring relative", contextTreeFileRowClassName(active, row.selected))}
        style={{ paddingLeft: rowPaddingLeft(depth) }}
      >
        <InsertionLine edge={drop.edge} inset={rowPaddingLeft(depth)} />
        <span className="h-7 w-4 shrink-0" aria-hidden />
        <RowIcon icon={fileKindIcon(file)} />
        <span className="ml-0.5 flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate">{file.name}</span>
          <LinkUpdateNote
            projectId={env.projectId}
            subject={{ kind: "file", id: file.documentId }}
            operationId={interaction.operationId}
            layout="stacked"
          />
        </span>
        {file.namespaceFailure ? (
          <NamespaceFailureMark
            failure={file.namespaceFailure}
            move={Boolean(file.namespaceRepairMove)}
          />
        ) : null}
        <EntryKebabButton allowedActions={interaction.actions} onAction={interaction.onAction} />
      </div>
    </EntryInteractionShell>
  );
}

function RenameRow({
  options,
  depth,
  icon,
}: {
  options: Parameters<typeof useRenameEntryForm>[0];
  depth: number;
  icon: typeof Folder;
}) {
  const form = useRenameEntryForm(options);
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
  siblings,
}: {
  kind: ContextCreateKind;
  parent: string;
  depth: number;
  siblings: readonly ContextEntrySibling[];
}) {
  const env = useTreeEnv();
  const creation = env.creation;
  if (!creation) throw new Error("Create row requires creation capability");
  const form = useCreateEntryForm({
    projectId: env.projectId,
    scheme: env.scheme,
    kind,
    parent,
    siblings,
    onDone: creation.done,
    onCreated: kind === "file" ? creation.createdFile : undefined,
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
