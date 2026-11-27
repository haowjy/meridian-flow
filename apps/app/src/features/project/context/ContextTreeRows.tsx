import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Folder, FolderOpen, LoaderCircle, type LucideIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { withGone } from "@/components/app/RowWord";
import { contentInset, ListRow, ListRowField } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import type { TreeDirectory, TreeFile, TreeView } from "@/core/project-tree/tree-view";
import { useRevealImport } from "@/features/import/ImportProvider";
import { type ImportedTree, type PendingRow, plainTree, rowId } from "@/features/import/tree-rows";
import { focusWhenFree } from "@/lib/focus-follow";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath } from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";
import { EntryDestinationPicker } from "./EntryDestinationPicker";
import { EntryNameField } from "./EntryNameField";
import type { DragEntry } from "./entry-drag/entry";
import { useEntryRow } from "./entry-drag/use-entry-row";
import { DropRegion, InsertionLine } from "./tree-drop/DropRegion";
import { type TreeDropTarget, useTreeDropTarget } from "./tree-drop/tree-drop";
import { useCreateEntryForm } from "./use-create-entry-form";
import {
  type EntryCapabilities,
  type EntryCreation,
  useEntryInteraction,
} from "./use-entry-interaction";
import { useRenameEntryForm } from "./use-rename-entry-form";
import type { TreeNoticeWords } from "./use-tree-notice-words";

export type TreeEnv = {
  projectId: string;
  owner: ContextOwner;
  capabilities: EntryCapabilities;
  scheme: ProjectContextTreeScheme;
  activeDocumentId: string | null;
  changed?: ReadonlySet<string> | null;
  meta?: (file: TreeFile) => ReactNode;
  crossedOut?: (file: TreeFile) => boolean;
  folderEnd?: (dir: TreeDirectory, open: boolean) => ReactNode;
  creation?: {
    creating: { kind: ContextCreateKind; parentPath: string } | null;
    request: EntryCreation;
    done: () => void;
    createdFile: (node: string) => void;
    createdFolder: string | null;
    setCreatedFolder: (node: string | null) => void;
    placeAt: (folderPath: string) => void;
  };
  onSelectFile: (scheme: ProjectContextTreeScheme, file: TreeFile) => void;
  notices: TreeNoticeWords;
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
  tree: TreeView;
  rows?: ImportedTree;
  visibleIds?: ReadonlySet<string>;
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

export function TreeGroup({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="relative isolate">
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-y-1 z-10 border-l border-border-subtle only:hidden"
        style={{ left: contentInset(depth - 1) + 8 }}
      />
    </div>
  );
}

export function TreeChildren({
  parentId,
  parentPath,
  depth,
  parent = null,
}: {
  parentId: string;
  parentPath: string;
  depth: number;
  parent?: DropFolder | null;
}) {
  const env = useTreeEnv();
  const rows = useMemo(() => env.rows ?? plainTree(env.tree), [env.rows, env.tree]);
  const children = rows.rows(parentId);
  const shown = children.filter(
    (child) =>
      child.origin === "import" || !env.visibleIds || env.visibleIds.has(child.node.entryId),
  );
  const held = withGone(shown, rowId, env.notices.deleted(parentId));
  return (
    <>
      {held.map((item) => {
        if (item.gone)
          return (
            <ListRow
              key={item.key}
              depth={depth}
              gone
              icon={item.row.kind === "folder" ? Folder : fileKindIcon(item.row.name)}
              title={item.row.name}
              notice={env.notices.word(item.key, true)}
            />
          );
        const child = item.row;
        return child.origin === "import" ? (
          <PendingTreeRow key={child.id} row={child} depth={depth} />
        ) : child.node.kind === "dir" ? (
          <DirRow key={item.key} dir={child.node} depth={depth} parent={parent} />
        ) : (
          <FileRow key={item.key} file={child.node} depth={depth} parent={parent} />
        );
      })}
      {env.creation?.creating?.parentPath === parentPath ? (
        <CreateRow
          kind={env.creation?.creating.kind}
          parentId={parentId}
          parent={parentPath}
          depth={depth}
        />
      ) : null}
    </>
  );
}

type DropFolder = NonNullable<TreeDropTarget["folder"]>;

const FILE_EDGE_BAND = 1 / 3;
const FOLDER_EDGE_BAND = 1 / 4;

function DirRow({
  dir,
  depth,
  parent,
}: {
  dir: TreeDirectory;
  depth: number;
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
    arriving: env.creation?.createdFolder === dir.entryId,
    onArrived: () => env.creation?.setCreatedFolder(null),
    importHere: env.importHere
      ? {
          folders: env.importHere.folders,
          start: (kind) => env.importHere?.start(folder, kind),
        }
      : undefined,
  });
  const isOpen = env.isExpanded(dir.entryId);
  const drop = useTreeDropTarget(
    { scheme: env.scheme, treeRootId: env.tree.root.entryId, folder },
    {
      reveal: () => !env.isExpanded(dir.entryId) && env.toggleEntry(dir.entryId),
      edges: { folder: parent, siblingId: dir.entryId, band: FOLDER_EDGE_BAND, after: !isOpen },
    },
  );
  const row = useEntryRow(interaction.entry, { active: false });
  if (interaction.renaming) {
    return (
      <RenameRow options={interaction.rename} depth={depth} icon={isOpen ? FolderOpen : Folder} />
    );
  }

  return (
    <DropRegion state={drop.dropState} flush>
      <InsertionLine edge={drop.edge} inset={contentInset(depth)} />
      <EntryDestinationPicker {...interaction.picker}>
        <ListRow
          ref={interaction.controlRef}
          depth={depth}
          icon={isOpen ? FolderOpen : Folder}
          title={dir.name}
          suffix={dir.suffix}
          onOpen={() => {
            if (env.creation?.creating) env.creation.done();
            env.creation?.placeAt(isOpen ? parentContextEntryPath(dir.path) : dir.path);
            env.toggleEntry(dir.entryId);
          }}
          selected={row.selected}
          controlProps={{ ...row.rowProps, "aria-expanded": isOpen }}
          frameProps={drop.dropProps}
          menu={interaction.menu}
          revealActions
          notice={env.notices.word(dir.entryId) ?? env.folderEnd?.(dir, isOpen)}
          trailing={env.changed?.has(dir.entryId) ? <DraftChangeMark /> : null}
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
  parent,
}: {
  file: TreeFile;
  depth: number;
  parent: DropFolder | null;
}) {
  const env = useTreeEnv();
  const drop = useTreeDropTarget(
    { scheme: env.scheme, treeRootId: env.tree.root.entryId, folder: parent },
    { edges: { folder: parent, siblingId: file.entryId, band: FILE_EDGE_BAND, after: true } },
  );
  const interaction = useEntryInteraction({
    projectId: env.projectId,
    node: file,
    owner: env.owner,
    scheme: env.scheme,
    capabilities: env.capabilities,
    onRequestDelete: env.onRequestDelete,
  });
  const active = file.documentId === env.activeDocumentId;
  const row = useEntryRow(interaction.entry, { active });
  if (interaction.renaming) {
    return <RenameRow options={interaction.rename} depth={depth} icon={fileKindIcon(file)} />;
  }

  return (
    <EntryDestinationPicker {...interaction.picker}>
      <InsertionLine edge={drop.edge} inset={contentInset(depth)} />
      <ListRow
        ref={interaction.controlRef}
        depth={depth}
        icon={fileKindIcon(file)}
        title={file.name}
        suffix={file.suffix}
        meta={env.meta?.(file)}
        crossedOut={env.crossedOut?.(file)}
        onOpen={() => env.onSelectFile(env.scheme, file)}
        current={active && "page"}
        selected={row.selected}
        controlProps={row.rowProps}
        frameProps={drop.dropProps}
        menu={interaction.menu}
        revealActions
        notice={env.notices.word(file.entryId)}
        trailing={env.changed?.has(file.documentId) ? <DraftChangeMark /> : null}
      />
    </EntryDestinationPicker>
  );
}

function DraftChangeMark() {
  return (
    <span className="mx-1 size-1.5 shrink-0 rounded-full bg-primary">
      <span className="sr-only">
        <Trans>, changed in the draft</Trans>
      </span>
    </span>
  );
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
  parentId,
  parent,
  depth,
}: {
  kind: ContextCreateKind;
  parentId: string;
  parent: string;
  depth: number;
}) {
  const env = useTreeEnv();
  const creation = env.creation;
  if (!creation) throw new Error("Create row requires creation capability");
  const [opener] = useState(() => document.activeElement);
  const form = useCreateEntryForm({
    projectId: env.projectId,
    scheme: env.scheme,
    kind,
    parentId,
    parent,
    onDone: creation.done,
    onCancel: () => {
      creation.done();
      if (opener instanceof HTMLElement) focusWhenFree(opener);
    },
    onCreated: kind === "file" ? creation.createdFile : creation.setCreatedFolder,
  });
  return (
    <ListRowField depth={depth} icon={form.icon}>
      <EntryNameField form={form} label={form.placeholder} placeholder={form.placeholder} />
    </ListRowField>
  );
}
