/**
 * The Agents tab: the project's `.agents/` and the writer's `~/.agents/` as trees, and the
 * built-in Agents and skills, read-only. Each file shows only what keeps it from use.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentFileStatus, AgentsLevel } from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { BookOpen, Bot, FilePlus, FolderPlus, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import type { TreeViewResult } from "@/client/query/useProjectTree";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { ListLine, ListRow, ListRowField } from "@/components/ui/list-row";
import { ListSectionHeader } from "@/components/ui/list-section";
import { useInlineEdit } from "@/components/ui/use-inline-edit";
import type { TreeActions } from "@/core/project-tree/tree-actions";
import type { TreeFile, TreeView } from "@/core/project-tree/tree-view";
import { agentFileAt, agentFileMark } from "@/features/agents/AgentFileNotice";
import { agentFileTemplate, writeFirstText } from "@/features/agents/agent-file-template";
import { BuiltinAgentFileDialog } from "@/features/agents/BuiltinAgentFileDialog";
import { useLiveDocumentSessionRegistry } from "../../context/account-feature-context";
import { type ContextTree, ContextTreeBody, useContextTree } from "../../context/ContextTreePanel";
import { validateContextEntryName } from "../../context/context-entry-name";
import { EntryNameField } from "../../context/EntryNameField";
import { useEntryActions } from "../../context/entry-drag/entry-actions";
import { treeActionMessage } from "../../context/tree-action-message";
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
  const markOf = useCallback(
    (scheme: ProjectContextTreeScheme) => (file: TreeFile) => {
      const mark = agentFileMark(agentFileAt(files, scheme, file.path));
      return mark ? <span className="text-muted-foreground">{mark}</span> : null;
    },
    [files],
  );
  const shared = { writable, projectId, editorWorkId, activeDocumentId, onSelectFile, onPicked };
  const project = useContextTree({
    ...shared,
    scheme: "agents",
    treeState: trees.agents,
    meta: markOf("agents"),
  });
  const user = useContextTree({
    ...shared,
    scheme: "user",
    treeState: trees.user,
    rootPath: "/.agents",
    meta: markOf("user"),
  });
  const [builtin, setBuiltin] = useState<AgentFileStatus | null>(null);
  const builtins = (files ?? []).filter((file) => file.level === "builtin");
  return (
    <SourcePane
      label={t`Agents`}
      drop={drop}
      notice={project.notices.header ?? user.notices.header}
    >
      <LevelSection level="project" tree={project} writable={writable} />
      <LevelSection level="user" tree={user} writable={writable} />
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

/** One level's heading, its New menu, and its rows. */
function LevelSection({
  level,
  tree,
  writable,
}: {
  level: AgentsLevel;
  tree: ContextTree;
  writable: boolean;
}) {
  const [naming, setNaming] = useState<NewKind | null>(null);
  // An item that opens a name field keeps focus there: the menu must not hand it back on close.
  const fieldOpened = useRef(false);
  const label = level === "project" ? t`Project` : t`Yours`;
  const address = level === "project" ? ".agents/" : "~/.agents/";
  const actions =
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
    ) : undefined;
  return (
    <section aria-label={label} className="pb-1">
      <ListSectionHeader label={label} title={address} actions={actions} />
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
      if (!made.ok) throw new Error(treeActionMessage(made.reason, "file"));
      const template = agentFileTemplate(
        [...newFilePath(kind, name).folders, newFilePath(kind, name).leaf].join("/"),
      );
      if (template) void writeFirstText(registry, projectId, made.node, template);
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
):
  | { ok: true; node: string; path: string }
  | { ok: false; reason: Parameters<typeof treeActionMessage>[0] } {
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
    if (!made.ok) return made;
    parentId = made.node;
    path = `${path}/${made.name}`;
  }
  const made = list.create({ parentId, kind: "document", name: at.leaf, filetype: "source" });
  if (!made.ok) return made;
  return { ok: true, node: made.node, path: `${path}/${made.name}` };
}
