/** Direct-child rows and inline actions for one context catalog scheme. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Folder, FolderOpen, LoaderCircle, type LucideIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import type {
  CatalogContextView,
  CatalogFile as ContextFile,
  CatalogNode as ContextNode,
} from "@/client/query/context-catalog-projection";
import { contentInset, ICON_SLOT_PX, ListRow, ListRowField } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import { useRevealImport } from "@/features/import/ImportProvider";
import {
  type ImportedTree,
  type PendingRow,
  plainTree,
  rowId,
  siblingsOf,
} from "@/features/import/tree-rows";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import { EntryDestinationPicker } from "./EntryDestinationPicker";
import { EntryNameField } from "./EntryNameField";
import { EntryRefusalNotice } from "./EntryRefusalNotice";
import type { DragEntry } from "./entry-drag/entry";
import { useEntryRow } from "./entry-drag/use-entry-row";
import { LinkUpdateNote } from "./LinkUpdateNote";
import { NamespaceFailureMark } from "./NamespaceFailureMark";
import { DropRegion, InsertionLine } from "./tree-drop/DropRegion";
import { type TreeDropTarget, useTreeDropTarget } from "./tree-drop/tree-drop";
import { useCreateEntryForm } from "./use-create-entry-form";
import {
  type EntryCapabilities,
  type EntryCreation,
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
  onRequestDelete: (entries: readonly DragEntry[]) => void;
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
  /** Rows say a refusal in words with its repair, where nothing can hover (the phone). */
  refusalNotice?: true;
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
      {/* An empty folder draws no guide stub: alone in the group, it hides. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-y-1 z-10 border-l border-border-subtle only:hidden"
        // Under the parent row's icon.
        style={{ left: contentInset(depth - 1) + 8 }}
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
  const row = useEntryRow(interaction.entry, {
    active: false,
    draggable: !dir.navigationOnly,
  });
  if (interaction.renaming) {
    return (
      <RenameRow options={interaction.rename} depth={depth} icon={isOpen ? FolderOpen : Folder} />
    );
  }

  return (
    <DropRegion state={drop.dropState} flush>
      {/* The region spans the subtree, so "after" lands below everything shown inside. */}
      <InsertionLine edge={drop.edge} inset={contentInset(depth)} />
      <EntryDestinationPicker {...interaction.picker}>
        <ListRow
          depth={depth}
          // The open or closed folder is the twistie: rows need no chevron column.
          icon={isOpen ? FolderOpen : Folder}
          title={dir.name}
          onOpen={() => {
            if (env.creation?.creating) env.creation.done();
            env.toggleEntry(dir.entryId);
          }}
          selected={row.selected}
          controlProps={{ ...row.rowProps, "aria-expanded": isOpen }}
          frameProps={drop.dropProps}
          menu={interaction.menu}
          revealActions
          detail={
            <LinkUpdateNote
              projectId={env.projectId}
              subject={{ kind: "folder", id: dir.entryId }}
              operationId={interaction.operationId}
              layout="stacked"
            />
          }
          trailing={
            dir.namespaceFailure && !env.refusalNotice ? (
              <NamespaceFailureMark
                failure={dir.namespaceFailure}
                move={Boolean(dir.namespaceRepairMove)}
                folder
              />
            ) : null
          }
          below={
            dir.namespaceFailure && env.refusalNotice ? (
              <RowNotice depth={depth}>
                <EntryRefusalNotice
                  failure={dir.namespaceFailure}
                  move={Boolean(dir.namespaceRepairMove)}
                  folder
                  actions={interaction.actions}
                  onAction={interaction.onAction}
                />
              </RowNotice>
            ) : null
          }
        />
      </EntryDestinationPicker>
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
  const reveal = useRevealImport();
  const element = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    element.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <ListRow
      ref={element}
      depth={depth}
      icon={Folder}
      title={<span className={role.secondary}>{row.name}</span>}
      onOpen={() => reveal?.(row.importId)}
      trailing={
        <>
          <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          <span className="sr-only">
            <Trans>Import in progress. Show activity</Trans>
          </span>
        </>
      }
    />
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
    onRequestDelete: env.onRequestDelete,
    siblings,
  });
  const active = env.scheme === env.activeScheme && file.path === env.activePath;
  const row = useEntryRow(interaction.entry, { active });
  if (interaction.renaming) {
    return <RenameRow options={interaction.rename} depth={depth} icon={fileKindIcon(file)} />;
  }

  return (
    <EntryDestinationPicker {...interaction.picker}>
      <InsertionLine edge={drop.edge} inset={contentInset(depth)} />
      <ListRow
        depth={depth}
        icon={fileKindIcon(file)}
        title={file.name}
        onOpen={() => env.onSelectFile(env.scheme, file)}
        current={active && "page"}
        selected={row.selected}
        controlProps={row.rowProps}
        frameProps={drop.dropProps}
        menu={interaction.menu}
        revealActions
        detail={
          <LinkUpdateNote
            projectId={env.projectId}
            subject={{ kind: "file", id: file.documentId }}
            operationId={interaction.operationId}
            layout="stacked"
          />
        }
        trailing={
          file.namespaceFailure && !env.refusalNotice ? (
            <NamespaceFailureMark
              failure={file.namespaceFailure}
              move={Boolean(file.namespaceRepairMove)}
            />
          ) : null
        }
        below={
          file.namespaceFailure && env.refusalNotice ? (
            <RowNotice depth={depth}>
              <EntryRefusalNotice
                failure={file.namespaceFailure}
                move={Boolean(file.namespaceRepairMove)}
                actions={interaction.actions}
                onAction={interaction.onAction}
              />
            </RowNotice>
          ) : null
        }
      />
    </EntryDestinationPicker>
  );
}

/** Under a row, on its title's edge: a refusal said in words, with its repair. */
function RowNotice({ depth, children }: { depth: number; children: ReactNode }) {
  return <div style={{ paddingLeft: contentInset(depth) + ICON_SLOT_PX }}>{children}</div>;
}

function RenameRow({
  options,
  depth,
  icon,
}: {
  options: Parameters<typeof useRenameEntryForm>[0];
  depth: number;
  icon: LucideIcon;
}) {
  const form = useRenameEntryForm(options);
  return (
    <ListRowField depth={depth} icon={icon}>
      <EntryNameField form={form} label={t`Rename`} />
    </ListRowField>
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
    <ListRowField depth={depth} icon={form.icon}>
      <EntryNameField form={form} label={form.placeholder} placeholder={form.placeholder} />
    </ListRowField>
  );
}
