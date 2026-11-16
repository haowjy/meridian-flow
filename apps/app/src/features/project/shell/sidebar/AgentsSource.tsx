/**
 * The Agents tab: the project's `.agents/` and the writer's `~/.agents/` as trees, and the
 * built-in Agents and skills, read-only. Each package (a level's own files, an import under
 * `packages/`) ends its heading or folder row with its Save state and Save; each file with what
 * keeps it from use or from the saved version.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  type AgentFileStatus,
  type AgentFiles,
  type AgentPackageStatus,
  type AgentsLevel,
  type AgentsLocation,
  agentsLocationOf,
} from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { BookOpen, Bot, FilePlus, FolderPlus, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import type { TreeViewResult } from "@/client/query/useProjectTree";
import { RowWord } from "@/components/app/RowWord";
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
import { LabelNote } from "@/components/ui/marks";
import { useInlineEdit } from "@/components/ui/use-inline-edit";
import { makeFolders, type TreeActions } from "@/core/project-tree/tree-actions";
import type { TreeDirectory, TreeFile, TreeView } from "@/core/project-tree/tree-view";
import { agentFileAt } from "@/features/agents/AgentFileState";
import { writeFirstAgentText } from "@/features/agents/agent-file-template";
import { BuiltinAgentFileDialog } from "@/features/agents/BuiltinAgentFileDialog";
import { fileTrouble, outOfUseUnder, outOfUseWord } from "@/features/agents/findings";
import { PackageSave, savedNotes } from "@/features/agents/PackageSave";
import {
  failsSave,
  importName,
  type PackageRef,
  packageFolderOf,
  statusOf,
  usePackageSaves,
} from "@/features/agents/package-save";
import { cn } from "@/lib/utils";
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
        <span className={mark.gone ? "text-destructive" : "text-muted-foreground"}>
          {mark.word}
        </span>
      ) : null;
    },
    [files],
  );
  const crossedOutOf = useCallback(
    (scheme: ProjectContextTreeScheme) => (file: TreeFile) =>
      Boolean(levelFileMark(files, scheme, file.path)?.gone),
    [files],
  );
  const packages = files?.packages;
  const folderEndOf = useCallback(
    (scheme: ProjectContextTreeScheme) => (dir: TreeDirectory, open: boolean) => {
      const at = agentsLocationOf(scheme, dir.path.slice(1));
      if (!at) return null;
      const pkg = /^packages\/[^/]+$/.test(at.path)
        ? { level: at.level, folder: `${at.path}/` }
        : null;
      const status = pkg ? statusOf(packages, pkg) : undefined;
      // A failing package's problem chip is the row's one mark: a count beside it pushes the name out.
      const inside = open || (status && failsSave(status)) ? null : outOfUseInside(files, at);
      // The slot takes the row's trailing marks' place, so it is filled only with something to say.
      const save = writable && pkg && saves.shows(pkg, status) ? pkg : null;
      if (!inside && !save) return null;
      return (
        <span className="flex min-w-0 shrink-0 items-center gap-1">
          {inside ? <InsideCount inside={inside} short={save !== null} /> : null}
          {save ? <PackageSave projectId={projectId} pkg={save} status={status} /> : null}
        </span>
      );
    },
    // `revision`: a Save or Undo changes what `shows` answers.
    [projectId, files, packages, writable, saves.revision],
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
              meta={file.hiddenBy ? t`Hidden` : undefined}
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
 * What a level's file row says after its name, the first that applies (`fileTrouble`):
 * Unavailable (no good save is in use; the name is struck through), Not in use (its edit has an
 * Error, its last good save is used instead), Unsaved (it differs from the saved version),
 * Hidden. A package-level Error is said on the package's row, not on each file.
 */
function levelFileMark(
  files: AgentFiles | null,
  scheme: ProjectContextTreeScheme,
  treePath: string,
): { word: string; gone: boolean } | null {
  const at = agentsLocationOf(scheme, treePath.replace(/^\//, ""));
  if (!at || !files) return null;
  const status = statusOf(files.packages, { level: at.level, folder: packageFolderOf(at.path) });
  const verdict = agentFileAt(files.files, scheme, treePath);
  const trouble = verdict ? fileTrouble(verdict, status) : null;
  if (trouble?.kind === "unavailable") return { word: t`Unavailable`, gone: true };
  if (trouble?.kind === "not-in-use") return { word: t`Not in use`, gone: false };
  if (status?.changes.some((change) => change.path === at.path && change.change !== "deleted"))
    return { word: t`Unsaved`, gone: false };
  return trouble?.kind === "hidden" ? { word: t`Hidden`, gone: false } : null;
}

/**
 * What a closed folder holds out of use, so closing it hides no problem: the count every level
 * says (`outOfUseWord`), else a package that can't be saved.
 */
function outOfUseInside(
  files: AgentFiles | null,
  at: AgentsLocation,
): { word: string; tone: "destructive" | "warning" | "muted"; count: number } | null {
  if (!files) return null;
  const prefix = at.path ? `${at.path}/` : "";
  const out = outOfUseWord(outOfUseUnder(files.files, files.packages, { level: at.level, prefix }));
  if (out) return out;
  // A package's own row says its problem; a folder above it says it holds one.
  const failing = files.packages.filter(
    (item) =>
      item.level === at.level &&
      item.folder.startsWith(prefix) &&
      item.folder !== prefix &&
      failsSave(item),
  ).length;
  return failing
    ? {
        word: plural(failing, { one: "# can't be saved", other: "# can't be saved" }),
        tone: "muted",
        count: failing,
      }
    : null;
}

/**
 * A closed folder's count. Beside a package's Save it gives way to the name: a dot and the
 * number, the full count its sentence, on a long press too.
 */
function InsideCount({
  inside,
  short,
}: {
  inside: NonNullable<ReturnType<typeof outOfUseInside>>;
  short: boolean;
}) {
  if (!short) return <LabelNote className="shrink-0 px-1">{inside.word}</LabelNote>;
  return (
    <RowWord
      tone="note"
      sentence={inside.word}
      word={
        <span className="flex items-center gap-1 tabular-nums">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              inside.tone === "destructive"
                ? "bg-destructive"
                : inside.tone === "warning"
                  ? "bg-warning"
                  : "bg-current",
            )}
          />
          {inside.count}
        </span>
      }
    />
  );
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
  const removed: PackageRef[] = (packages ?? [])
    .filter(
      (item) =>
        item.level === level &&
        item.folder !== "" &&
        (item.state === "removed" ||
          (item.state === "saved" && item.savedAt === null && item.undoable !== null)),
    )
    .map(({ folder }) => ({ level, folder }));
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
                  {statusOf(packages, pkg)?.state === "removed" ? (
                    <Trans>{name} was removed. Save to stop using it.</Trans>
                  ) : (
                    <Trans>{name} was removed.</Trans>
                  )}
                </span>
                {writable ? (
                  <PackageSave projectId={projectId} pkg={pkg} status={statusOf(packages, pkg)} />
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
      const named = validateContextEntryName(name, "folder");
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
      tree.openWhenListed(made.node);
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
): { node: string } {
  const parentId = makeFolders(view, list, [rootPath, ...at.folders].join("/"));
  return list.create({ parentId, kind: "document", name: at.leaf, filetype: "source" });
}
