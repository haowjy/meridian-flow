/**
 * The Agents tab: the project's `.agents/` and the writer's `~/.agents/` as trees, and the
 * built-in Agents and skills, read-only. Each package (a level's own files, an import under
 * `packages/`) ends its heading or folder row with its Save state and Save; each file with what
 * keeps it from use or from the saved version.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  type AgentFileStatus,
  type AgentFiles,
  type AgentPackageStatus,
  type AgentsLevel,
  agentsLocationOf,
} from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { BookOpen, Bot, FilePlus, FolderPlus, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import type { TreeViewResult } from "@/client/query/useProjectTree";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import {
  contentInset,
  ICON_SLOT_PX,
  ListLine,
  ListRow,
  ListRowField,
} from "@/components/ui/list-row";
import { ListSectionHeader } from "@/components/ui/list-section";
import { useInlineEdit } from "@/components/ui/use-inline-edit";
import type { TreeActions } from "@/core/project-tree/tree-actions";
import type { TreeDirectory, TreeFile, TreeView } from "@/core/project-tree/tree-view";
import { agentFileAt, agentFileMark } from "@/features/agents/AgentFileNotice";
import { writeFirstAgentText } from "@/features/agents/agent-file-template";
import { BuiltinAgentFileDialog } from "@/features/agents/BuiltinAgentFileDialog";
import { PackageSave, savedNotes } from "@/features/agents/PackageSave";
import {
  errorsOf,
  importName,
  type PackageRef,
  packageFolderOf,
  statusOf,
  usePackageSaves,
} from "@/features/agents/package-save";
import { useLiveDocumentSessionRegistry } from "../../context/account-feature-context";
import { type ContextTree, ContextTreeBody, useContextTree } from "../../context/ContextTreePanel";
import { validateContextEntryName } from "../../context/context-entry-name";
import { EntryNameField } from "../../context/EntryNameField";
import { useEntryActions } from "../../context/entry-drag/entry-actions";
import { type SourceDrop, SourcePane } from "./SourcePane";

type NewKind = "agent" | "skill";

export function AgentsSource({
  projectId,
  editorWorkId,
  activeDocumentId,
  onSelectFile,
  onPicked,
  trees,
  writable,
  drop,
}: {
  projectId: string;
  editorWorkId: string | null;
  activeDocumentId: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: TreeFile,
    options?: { focus?: true },
  ) => void;
  onPicked?: () => void;
  trees: { agents: TreeViewResult; user: TreeViewResult };
  writable: boolean;
  drop: SourceDrop;
}) {
  const files = useAgentFiles(projectId);
  const saves = usePackageSaves(projectId);
  const markOf = useCallback(
    (scheme: ProjectContextTreeScheme) => (file: TreeFile) => {
      const mark = levelFileMark(files, scheme, file.path);
      return mark ? (
        <span className={mark.error ? "text-destructive" : "text-muted-foreground"}>
          {mark.word}
        </span>
      ) : null;
    },
    [files],
  );
  const crossedOutOf = useCallback(
    (scheme: ProjectContextTreeScheme) => (file: TreeFile) =>
      Boolean(levelFileMark(files, scheme, file.path)?.error),
    [files],
  );
  const packages = files?.packages;
  const folderEndOf = useCallback(
    (scheme: ProjectContextTreeScheme) => (dir: TreeDirectory) => {
      const at = writable ? agentsLocationOf(scheme, dir.path.slice(1)) : null;
      if (!at || !/^packages\/[^/]+$/.test(at.path)) return null;
      const pkg = { level: at.level, folder: `${at.path}/` };
      const status = statusOf(packages, pkg);
      // The slot takes the row's trailing marks' place, so it is filled only with something to say.
      return saves.shows(pkg, status) ? (
        <PackageSave projectId={projectId} pkg={pkg} status={status} />
      ) : null;
    },
    // `revision`: a Save or Undo changes what `shows` answers.
    [projectId, packages, writable, saves.revision],
  );
  const shared = { writable, projectId, editorWorkId, activeDocumentId, onSelectFile, onPicked };
  const project = useContextTree({
    ...shared,
    scheme: "agents",
    treeState: trees.agents,
    meta: markOf("agents"),
    crossedOut: crossedOutOf("agents"),
    folderEnd: folderEndOf("agents"),
  });
  const user = useContextTree({
    ...shared,
    scheme: "user",
    treeState: trees.user,
    rootPath: "/.agents",
    meta: markOf("user"),
    crossedOut: crossedOutOf("user"),
    folderEnd: folderEndOf("user"),
  });
  const [builtin, setBuiltin] = useState<AgentFileStatus | null>(null);
  const builtins = (files?.files ?? []).filter((file) => file.level === "builtin");
  const changed = (packages ?? []).filter((item) => item.state !== "saved");
  return (
    <SourcePane
      label={t`Agents`}
      drop={drop}
      notice={project.notices.header ?? user.notices.header}
      actions={
        writable && changed.length >= 2 ? (
          <Button
            type="button"
            variant="quiet"
            size="meta"
            className="text-jade-text"
            onClick={() => void saves.save(changed)}
          >
            <Trans>Save all</Trans>
          </Button>
        ) : undefined
      }
    >
      <LevelSection
        level="project"
        tree={project}
        writable={writable}
        projectId={projectId}
        packages={packages}
      />
      <LevelSection
        level="user"
        tree={user}
        writable={writable}
        projectId={projectId}
        packages={packages}
      />
      <ListSectionHeader label={t`Built-in`} />
      <div className="px-2">
        {files === null ? (
          <ListLine iconSlot status>
            <Trans>Loading Agents…</Trans>
          </ListLine>
        ) : (
          builtins.map((file) => (
            <ListRow
              key={file.path}
              icon={file.kind === "agent" ? Bot : BookOpen}
              title={file.slug}
              meta={agentFileMark(file)}
              onOpen={() => setBuiltin(file)}
            />
          ))
        )}
      </div>
      <BuiltinAgentFileDialog file={builtin} onClose={() => setBuiltin(null)} />
    </SourcePane>
  );
}

/**
 * What a level's file row says after its name, the first that applies: Error (Mars can't use
 * it, so a Save leaves it out, or it fails the package's Save; the row is struck through),
 * Unsaved (it differs from the saved version), Hidden.
 */
function levelFileMark(
  files: AgentFiles | null,
  scheme: ProjectContextTreeScheme,
  treePath: string,
): { word: string; error: boolean } | null {
  const at = agentsLocationOf(scheme, treePath.replace(/^\//, ""));
  if (!at || !files) return null;
  const folder = packageFolderOf(at.path);
  const status = statusOf(files.packages, { level: at.level, folder });
  const inPackage = at.path.slice(folder.length);
  const verdict = agentFileAt(files.files, scheme, treePath);
  if (
    (verdict && verdict.unavailableReasons.length > 0) ||
    (status && errorsOf(status.findings).some((finding) => finding.file === inPackage))
  )
    return { word: t`Error`, error: true };
  if (status?.changes.some((change) => change.path === at.path && change.change !== "deleted"))
    return { word: t`Unsaved`, error: false };
  const word = agentFileMark(verdict);
  return word ? { word, error: false } : null;
}

/** One level's heading, its New menu, and its rows. */
function LevelSection({
  level,
  tree,
  writable,
  projectId,
  packages,
}: {
  level: AgentsLevel;
  tree: ContextTree;
  writable: boolean;
  projectId: string;
  packages: readonly AgentPackageStatus[] | undefined;
}) {
  const saves = usePackageSaves(projectId);
  const own = { level, folder: "" };
  const [naming, setNaming] = useState<NewKind | null>(null);
  // An item that opens a name field keeps focus there: the menu must not hand it back on close.
  const fieldOpened = useRef(false);
  const label = level === "project" ? t`Project` : t`Yours`;
  const address = level === "project" ? ".agents/" : "~/.agents/";
  const menu =
    writable && tree.creates ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" label={t`New in ${address}`}>
            <Plus aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44"
          onCloseAutoFocus={(event) => {
            if (fieldOpened.current) event.preventDefault();
            fieldOpened.current = false;
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              fieldOpened.current = true;
              setNaming("agent");
            }}
          >
            <Bot className="size-4" aria-hidden />
            <Trans>New Agent</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              fieldOpened.current = true;
              setNaming("skill");
            }}
          >
            <BookOpen className="size-4" aria-hidden />
            <Trans>New skill</Trans>
          </DropdownMenuItem>
          {tree.rootPath === "" || tree.rootFolder ? (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  fieldOpened.current = true;
                  tree.requestCreate("file", tree.here);
                }}
              >
                <FilePlus className="size-4" aria-hidden />
                <Trans>New file</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  fieldOpened.current = true;
                  tree.requestCreate("folder", tree.here);
                }}
              >
                <FolderPlus className="size-4" aria-hidden />
                <Trans>New folder</Trans>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  const state = writable ? (
    <PackageSave projectId={projectId} pkg={own} status={statusOf(packages, own)} />
  ) : null;
  // A removed import has no row in the tree: its line stands under the heading while it, or its
  // Save's word, lasts.
  const removed: PackageRef[] = [
    ...(packages ?? [])
      .filter((item) => item.level === level && item.folder !== "" && item.state === "removed")
      .map(({ folder }) => ({ level, folder })),
    ...saves.removedWithWord(level, packages),
  ];
  const notes = (packages ?? [])
    .filter((item) => item.level === level)
    .flatMap((item) => {
      const lines = savedNotes(saves.wordOf(item, item));
      return lines ? [{ pkg: item, lines }] : [];
    });
  return (
    <section aria-label={label} className="pb-1">
      <ListSectionHeader
        label={label}
        title={address}
        actions={
          state || menu ? (
            <>
              {state}
              {menu}
            </>
          ) : undefined
        }
      />
      {notes.length > 0 || removed.length > 0 ? (
        <div className="px-2">
          {notes.map(({ pkg, lines }) =>
            lines.map((line) => (
              <ListLine key={`${pkg.folder}:${line}`} iconSlot>
                {pkg.folder ? `${importName(pkg.folder)}: ${line}` : line}
              </ListLine>
            )),
          )}
          {removed.map((pkg) => {
            const name = importName(pkg.folder);
            return (
              <div
                key={pkg.folder}
                className="flex min-h-7 items-center gap-2 pr-1.5 text-xs text-muted-foreground"
                style={{ paddingLeft: contentInset(0) + ICON_SLOT_PX }}
                data-removed-package={name}
              >
                <span className="min-w-0 flex-1">
                  {statusOf(packages, pkg) ? (
                    <Trans>{name} was removed. Save to stop using it.</Trans>
                  ) : (
                    <Trans>{name} was removed.</Trans>
                  )}
                </span>
                {writable ? (
                  <PackageSave
                    projectId={projectId}
                    pkg={pkg}
                    status={statusOf(packages, pkg)}
                    look="bare"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {naming && tree.tree ? (
        <div className="px-2">
          <NewLevelFileRow
            kind={naming}
            level={level}
            tree={tree}
            view={tree.tree}
            onDone={() => setNaming(null)}
          />
        </div>
      ) : null}
      <ContextTreeBody
        tree={tree}
        emptyLine={
          level === "project" ? (
            <Trans>No Agents or skills in this project yet.</Trans>
          ) : (
            <Trans>None of your own yet. Yours show in every project.</Trans>
          )
        }
      />
    </section>
  );
}

/** Where an Agent or skill of this name is made, under a level's root. */
function newFilePath(kind: NewKind, name: string): { folders: string[]; leaf: string } {
  return kind === "agent"
    ? { folders: ["agents"], leaf: `${name}.md` }
    : { folders: ["skills", name], leaf: "SKILL.md" };
}

/**
 * The name field for a new Agent or skill. The file is made with the folders it needs and a
 * starting text Mars reads cleanly, then opens.
 */
function NewLevelFileRow({
  kind,
  level,
  tree,
  view,
  onDone,
}: {
  kind: NewKind;
  level: AgentsLevel;
  tree: ContextTree;
  view: TreeView;
  onDone: () => void;
}) {
  const projectId = tree.env?.projectId ?? "";
  const actions = useEntryActions(projectId);
  const registry = useLiveDocumentSessionRegistry();
  const list = level === "user" ? actions.account : actions.project;
  const form = useInlineEdit({
    initial: "",
    validate: (draft) => {
      const name = draft.trim();
      if (!name) return null;
      const named = validateContextEntryName(name, [], "folder");
      if (named?.level === "error") return named;
      const { folders, leaf } = newFilePath(kind, name);
      return view.findPath([tree.rootPath, ...folders, leaf].join("/"))
        ? {
            level: "error",
            message:
              kind === "agent"
                ? t`An Agent named ${name} is already here.`
                : t`A skill named ${name} is already here.`,
          }
        : null;
    },
    onCommit: (typed) => {
      const name = typed.trim();
      const made = makeLevelFile(list, view, tree.rootPath, newFilePath(kind, name));
      const file = newFilePath(kind, name);
      void writeFirstAgentText(
        registry,
        projectId,
        made.node,
        [...file.folders, file.leaf].join("/"),
      );
      tree.openWhenListed(made.path);
      onDone();
    },
    onCancel: onDone,
  });
  const label = kind === "agent" ? t`Agent name` : t`Skill name`;
  return (
    <ListRowField icon={kind === "agent" ? Bot : BookOpen}>
      <EntryNameField form={form} label={label} placeholder={label} />
    </ListRowField>
  );
}

/** Appends the folders a new file needs that the level lacks, then the file, to the writer's list. */
function makeLevelFile(
  list: TreeActions,
  view: TreeView,
  rootPath: string,
  at: { folders: string[]; leaf: string },
): { node: string; path: string } {
  let parentId = view.root.entryId;
  let path = "";
  for (const folder of [...rootPath.split("/").filter(Boolean), ...at.folders]) {
    const found = view.findPath(`${path}/${folder}`);
    if (found?.kind === "dir") {
      parentId = found.entryId;
      path = found.path;
      continue;
    }
    const made = list.create({ parentId, kind: "folder", name: folder });
    parentId = made.node;
    path = `${path}/${made.name}`;
  }
  const made = list.create({ parentId, kind: "document", name: at.leaf, filetype: "source" });
  return { node: made.node, path: `${path}/${made.name}` };
}
