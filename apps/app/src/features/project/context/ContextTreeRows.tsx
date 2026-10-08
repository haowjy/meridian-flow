/** Direct-child rows and inline actions for one context catalog scheme. */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { createContext, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
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

export type TreeEnv = {
  projectId: string;
  workId: string | null;
  scheme: ProjectContextTreeScheme;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  creating: { kind: ContextCreateKind; parentPath: string } | null;
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
  onRequestCreate: (kind: ContextCreateKind, parentPath: string) => void;
  onRequestDelete: (target: EntryActionTarget) => void;
  onCreateDone: () => void;
  onCreatedFilePath: (path: string) => void;
  isExpanded: (entryId: string, depth: number) => boolean;
  toggleEntry: (entryId: string, defaultOpen: boolean) => void;
  catalog: CatalogContextView;
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
}: {
  parentId: string;
  parentPath: string;
  depth: number;
}) {
  const env = useTreeEnv();
  const children = env.catalog.children(parentId);
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
          <DirRow key={child.entryId} dir={child} depth={depth} siblingNames={siblingNames} />
        ) : (
          <FileRow key={child.entryId} file={child} depth={depth} siblingNames={siblingNames} />
        ),
      )}
    </>
  );
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
  const [noteOperationId, setNoteOperationId] = useState<string | null>(null);
  const isOpen = env.isExpanded(dir.entryId, depth);
  // A refused rename offers its name field once, as the failure arrives.
  useRepairOnFreshFailure(dir.namespaceFailureAt, () => setRenaming(true));
  const toggle = () => {
    if (env.creating) env.onCreateDone();
    env.toggleEntry(dir.entryId, depth < 2);
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
      <ContextEntryMenu allowCreate={allowCreate} allowDelete={allowDelete} onAction={handleAction}>
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

  const active = env.scheme === env.activeScheme && file.path === env.activePath;
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
}

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
  const env = useTreeEnv();
  const form = useRenameEntryForm({
    projectId: env.projectId,
    owner: { workId: env.workId ?? undefined },
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
  const env = useTreeEnv();
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
