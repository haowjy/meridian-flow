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
  CatalogDirectory as ContextDir,
  CatalogFile as ContextFile,
  CatalogNode as ContextNode,
} from "@/client/query/context-catalog-projection";
import { useToastRegistry } from "@/components/app/toast-registry";
import { type ImportedTree, type PendingRow, rowId, siblingsOf } from "@/features/import/tree-rows";
import { cn } from "@/lib/utils";
import { type DeleteTarget, EntryKebabButton } from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import {
  contextTreeDropTargetClassName,
  contextTreeFileRowClassName,
  contextTreeRowClassName,
  contextTreeRowGrowClassName,
} from "./context-row-geometry";
import { EntryNameField } from "./EntryNameField";
import { LinkUpdateNote } from "./LinkUpdateNote";
import { NamespaceFailureMark } from "./NamespaceFailureMark";
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
  /** Opens the OS picker for an import into a folder; absent where the area takes no imports. */
  importHere?: {
    /** False where the browser cannot pick a whole folder. */
    folders: boolean;
    start: (
      folder: { entryId: string; path: string; uri: string; name: string } | null,
      kind: "folder" | "files",
    ) => void;
  };
  isExpanded: (entryId: string) => boolean;
  toggleEntry: (entryId: string) => void;
  /** The rows to draw: catalog nodes with import marks, and rows only an import draws. */
  tree: ImportedTree;
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
  parentId,
  parentPath,
  depth,
  parent = null,
}: {
  parentId: string;
  /** The folder's catalog path; null under a pending folder, which takes no new entries. */
  parentPath: string | null;
  depth: number;
  /** The folder these rows sit in; null at the area root. File rows drop into it. */
  parent?: DropFolder | null;
}) {
  const env = useTreeEnv();
  const rows = env.tree.rows(parentId);
  const siblings = useMemo(() => siblingsOf(rows), [rows]);
  return (
    <>
      {parentPath !== null && env.creation?.creating?.parentPath === parentPath ? (
        <CreateRow
          kind={env.creation?.creating.kind}
          parent={parentPath}
          depth={depth}
          siblings={siblings}
        />
      ) : null}
      {rows.map((row) =>
        row.origin === "import" ? (
          <PendingTreeRow key={row.id} row={row} depth={depth} />
        ) : row.node.kind === "dir" ? (
          <DirRow key={rowId(row)} dir={row.node} depth={depth} siblings={siblings} />
        ) : (
          <FileRow
            key={rowId(row)}
            file={row.node}
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

export function rowPaddingLeft(depth: number): number {
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

export function RowIcon({ icon: Icon, muted = false }: { icon: typeof Folder; muted?: boolean }) {
  return (
    <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
      <Icon aria-hidden className={cn("size-3.5", muted && "opacity-60")} />
    </span>
  );
}

export function ContextTreeEntry({
  node,
  depth,
  siblings,
}: {
  node: ContextNode;
  depth: number;
  siblings: readonly ContextEntrySibling[];
}) {
  return node.kind === "dir" ? (
    <DirRow dir={node} depth={depth} siblings={siblings} />
  ) : (
    <FileRow file={node} depth={depth} siblings={siblings} parent={null} />
  );
}

function DirRow({
  dir,
  depth,
  siblings,
}: {
  dir: ContextDir;
  depth: number;
  siblings: readonly ContextEntrySibling[];
}) {
  const env = useTreeEnv();
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
  const folder: DropFolder = { entryId: dir.entryId, path: dir.path, uri: dir.uri, name: dir.name };
  const drop = useTreeDropTarget(
    { scheme: env.scheme, folder },
    { onSpring: () => !env.isExpanded(dir.entryId) && env.toggleEntry(dir.entryId) },
  );
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
    <>
      <EntryInteractionShell interaction={interaction}>
        {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          aria-label={t`Toggle folder ${dir.name}`}
          onClick={toggle}
          onKeyDown={activateOnKey(toggle)}
          {...drop.dropProps}
          className={cn(
            "group focus-ring mx-2 flex items-center rounded-md pr-1 text-sm text-foreground hover:bg-sidebar-accent/50",
            contextTreeRowGrowClassName,
            drop.dropState === "over" && contextTreeDropTargetClassName,
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
          {drop.dropState === "over" ? (
            <span className="ml-2 mr-1 shrink-0 text-caption text-ink-muted">
              <Trans>Import here</Trans>
            </span>
          ) : null}
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
        <TreeChildren
          parentId={dir.entryId}
          parentPath={dir.path}
          depth={depth + 1}
          parent={folder}
        />
      ) : null}
    </>
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
  // A file is not a drop target of its own: it hands the drop to its folder (or the area).
  const { dropProps } = useTreeDropTarget({ scheme: env.scheme, folder: parent });
  const interaction = useEntryInteraction({
    projectId: env.projectId,
    node: file,
    owner: env.owner,
    scheme: env.scheme,
    capabilities: env.capabilities,
    create: env.creation?.request,
    onRequestDelete: env.onRequestDelete,
    siblings,
  });
  const select = () => env.onSelectFile(env.scheme, file);
  if (interaction.renaming) {
    return <RenameRow options={interaction.rename} depth={depth} icon={fileKindIcon(file)} />;
  }

  const active = env.scheme === env.activeScheme && file.path === env.activePath;

  return (
    <EntryInteractionShell interaction={interaction}>
      {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={select}
        onKeyDown={activateOnKey(select)}
        {...dropProps}
        className={cn("focus-ring", contextTreeFileRowClassName(active))}
        style={{ paddingLeft: rowPaddingLeft(depth) }}
      >
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

/** A row the importing tab draws before the server has made it: muted, inert, no menu. */
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
      <RowIcon icon={Folder} muted />
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
