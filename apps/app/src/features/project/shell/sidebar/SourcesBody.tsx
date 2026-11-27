import { t } from "@lingui/core/macro";
import { agentsLocationOf } from "@meridian/contracts/agents";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Ellipsis, ListChecks, type LucideIcon, MessageSquare, Trash2 } from "lucide-react";
import {
  type ComponentType,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type TreeViewResult, useProjectTreeViews } from "@/client/query/useProjectTree";
import { useWorks } from "@/client/query/useWorks";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { Chip } from "@/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import { tabListKeys } from "@/components/ui/tab-keys";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LIVE_VERSION } from "@/core/project-tree/tree-version";
import type { TreeFile as ContextFile } from "@/core/project-tree/tree-view";
import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { usePressCommands, type WorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useWorkDraftMenu } from "@/features/draft-review/work-draft-menu";
import { destinationOf } from "@/features/import/destination";
import { useOptionalImports } from "@/features/import/ImportProvider";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { ContextTreePanel } from "../../context/ContextTreePanel";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "../../context/context-schemes";
import type { MoveArea } from "../../context/entry-drag/move-plan";
import { EntryList, useEntryList } from "../../context/entry-drag/use-entry-list";
import { useOptionalTreeCreation } from "../../context/TreeCreationProvider";
import { DropRegion } from "../../context/tree-drop/DropRegion";
import { type FilesRoute, useTreeDropTarget } from "../../context/tree-drop/tree-drop";
import { revealPlaced, subscribePlacedReveal } from "../../context/tree-reveal";
import { useScopeScratchSource } from "../../context/use-scratch-trees";
import { useItemLauncher } from "../../review-launch";
import { useChatNavigation } from "../../routing/chat-navigation";
import { useTrashNavigation } from "../../routing/ProjectNavigationContext";
import { useShellTreeVersion } from "../../tree-version";
import { useOptionalMainItem, useShownDraft } from "../../views";
import { useWorkState } from "../../work/work-state";
import { AgentsSource } from "./AgentsSource";
import { type ChangesScope, ChangesSource, useChangesScope } from "./ChangesSource";
import { ChatsBody } from "./ChatsBody";
import type { SourceDrop } from "./SourcePane";
import { TREE_TABS, type TreeTab, useSidebarTabs } from "./sidebar-tabs-store";
import { TrashSource } from "./TrashSource";
import { useTrashDrop } from "./trash-drop";
import { useSidebarUndo } from "./use-sidebar-undo";

const TREE_SCHEMES = [...EDITOR_CONTEXT_SCHEMES, "scratch"] as const;
type TreeKey = (typeof TREE_SCHEMES)[number];

type SourceKey = "chat" | TreeTab | "scratch" | "unfiled" | "trash" | "changes";
const FOOT_SOURCES = ["scratch", "unfiled", "trash"] as const satisfies readonly SourceKey[];

type WriteSources = {
  projectId: string;
  scopeWorkId: string | null;
  chatThreadId: string | null;
  editorWorkId: string | null;
  activeScheme: ProjectContextTreeScheme | null;
  activeDocumentId: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  onPicked?: () => void;
  catalogs: Record<TreeKey, TreeViewResult>;
  writable: Record<TreeKey, boolean>;
  changes: ChangesScope;
  changesCommands: WorkDraftCommands;
};

const WriteSourcesContext = createContext<WriteSources | null>(null);

function useWriteSources(): WriteSources {
  const sources = useContext(WriteSourcesContext);
  if (!sources) throw new Error("A source needs SourcesBody");
  return sources;
}

type Source = {
  label: () => string;
  title?: (sources: WriteSources) => string;
  badge?: (sources: WriteSources) => number;
  icon: LucideIcon;
  useDrop: (reveal?: () => void) => SourceDrop;
  Body: ComponentType<{ drop: SourceDrop }>;
};

function useRootDrop(scheme: TreeKey, reveal?: () => void): SourceDrop {
  const rootId = useWriteSources().catalogs[scheme].tree?.root.entryId ?? null;
  const target = useMemo(
    () => ({ scheme, treeRootId: rootId ?? `${scheme}:loading`, folder: null }),
    [scheme, rootId],
  );
  return useTreeDropTarget(target, { reveal });
}

function treeSource(scheme: TreeKey): Source {
  return {
    label: () => schemeLabel(scheme),
    icon: schemeIcon(scheme),
    useDrop: (reveal) => useRootDrop(scheme, reveal),
    Body: ({ drop }) => {
      const sources = useWriteSources();
      return (
        <ContextTreePanel
          scheme={scheme}
          treeState={sources.catalogs[scheme]}
          writable={sources.writable[scheme]}
          projectId={sources.projectId}
          editorWorkId={sources.editorWorkId}
          activeDocumentId={sources.activeDocumentId}
          onSelectFile={sources.onSelectFile}
          onPicked={sources.onPicked}
          drop={drop}
        />
      );
    },
  };
}

const SOURCES: Record<SourceKey, Source> = {
  chat: {
    label: () => t`Chats`,
    icon: MessageSquare,
    useDrop: () => IDLE_DROP,
    Body: () => {
      const { projectId, scopeWorkId, chatThreadId, onPicked } = useWriteSources();
      const chat = useChatNavigation();
      const { noWork } = useWorks(projectId);
      return (
        <ChatsBody
          projectId={projectId}
          scopeWorkId={scopeWorkId}
          noWorkId={noWork?.id ?? null}
          currentThreadId={chatThreadId}
          onOpenChat={(threadId) => void chat.openChat(threadId).then(() => onPicked?.())}
          onNewChat={() => void chat.openNewChat().then(() => onPicked?.())}
        />
      );
    },
  },
  manuscript: treeSource("manuscript"),
  kb: treeSource("kb"),
  user: treeSource("user"),
  agents: {
    label: () => t`Agents`,
    icon: schemeIcon("agents"),
    useDrop: (reveal) => useRootDrop("agents", reveal),
    Body: ({ drop }) => {
      const sources = useWriteSources();
      return (
        <AgentsSource
          projectId={sources.projectId}
          editorWorkId={sources.editorWorkId}
          activeDocumentId={sources.activeDocumentId}
          onSelectFile={sources.onSelectFile}
          onPicked={sources.onPicked}
          trees={{ agents: sources.catalogs.agents, user: sources.catalogs.user }}
          writable={sources.writable.agents}
          drop={drop}
        />
      );
    },
  },
  scratch: treeSource("scratch"),
  unfiled: treeSource("unfiled"),
  trash: {
    label: () => t`Trash`,
    icon: Trash2,
    useDrop: () => useTrashDrop(useWriteSources().projectId),
    Body: ({ drop }) => {
      const { projectId, onPicked } = useWriteSources();
      return <TrashSource projectId={projectId} onPicked={onPicked} drop={drop} />;
    },
  },
  changes: {
    label: () => t`Changes`,
    title: ({ changes }) => changes.heading,
    badge: ({ changes }) => changes.count,
    icon: ListChecks,
    useDrop: () => IDLE_DROP,
    Body: () => {
      const { projectId, chatThreadId, changes, changesCommands, activeDocumentId, onPicked } =
        useWriteSources();
      const shownDraft = useShownDraft(projectId, chatThreadId);
      return (
        <ChangesSource
          key={changes.drafts.map((draft) => draft.id).join()}
          projectId={projectId}
          scope={changes}
          controller={changesCommands}
          isOpen={(file) =>
            file.documentId === activeDocumentId &&
            shownDraft(file.documentId)?.draftId === file.item.draftId
          }
          onPicked={onPicked}
        />
      );
    },
  },
};

const IDLE_DROP: SourceDrop = { dropProps: {}, dropState: "idle" };

function isTreeKey(key: string): key is TreeKey {
  return (TREE_SCHEMES as readonly string[]).includes(key);
}

function isTreeTab(key: string): key is TreeTab {
  return (TREE_TABS as readonly string[]).includes(key);
}

function listedInAgents(scheme: TreeKey, path: string): boolean {
  return agentsLocationOf(scheme, path.replace(/^\//, "")) !== null;
}

function sourceShowing(scheme: TreeKey, inAgents: boolean, shown: SourceKey): SourceKey {
  if (shown === scheme || (shown === "agents" && inAgents)) return shown;
  return inAgents ? "agents" : scheme;
}

export function SourcesBody({
  projectId,
  scopeWorkId,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeScheme: mainScheme,
  activeWorkId,
  onSelectFile,
  onPicked,
}: Omit<
  WriteSources,
  "catalogs" | "writable" | "changes" | "changesCommands" | "activeDocumentId"
> & {
  contextLive: boolean;
  activeWorkId: string | null;
}) {
  const scratchWorkId = useScopeScratchSource(projectId)?.owner.workId ?? null;
  const scratchWritable = useWorkState(projectId, scratchWorkId).kind !== "ended";
  const listed =
    mainScheme !== "scratch" || (scratchWorkId !== null && activeWorkId === scratchWorkId);
  const activeScheme = listed ? mainScheme : null;
  const main = useOptionalMainItem()?.item;
  const activeDocumentId = main?.kind === "document" ? main.documentId : null;
  const chosen = useSidebarTabs((state) => state.shown);
  useEffect(() => {
    void useSidebarTabs.persist.rehydrate();
  }, []);
  const showTab = useSidebarTabs((state) => state.show);
  const mainChat = useChatNavigation().display;
  const mainChatKey = mainChat
    ? mainChat.kind === "thread"
      ? mainChat.threadId
      : mainChat.kind
    : null;
  const [picked, setPicked] = useState<SourceKey>(mainChat ? "chat" : "manuscript");
  const shownRef = useRef(picked);
  shownRef.current = picked;
  const follow = useCallback(
    (source: SourceKey) => {
      if (isTreeTab(source)) showTab(source);
      setPicked((current) => (current === "changes" ? current : source));
    },
    [showTab],
  );
  useEffect(() => {
    if (mainChatKey) follow("chat");
  }, [mainChatKey, follow]);
  const asked = useSidebarTabs((state) => state.asked);
  const settle = useSidebarTabs((state) => state.settle);
  useEffect(() => {
    if (!asked) return;
    setPicked(asked.source);
    settle();
  }, [asked, settle]);
  const trashShown = useTrashNavigation().shown;
  useEffect(() => {
    if (trashShown) follow("trash");
  }, [trashShown, follow]);
  const creating = useOptionalTreeCreation()?.request;
  const creatingScheme = creating && isTreeKey(creating.scheme) ? creating.scheme : null;
  const creatingInAgents =
    creating && creatingScheme ? listedInAgents(creatingScheme, creating.parentPath) : false;
  useEffect(() => {
    if (!creatingScheme) return;
    const source = sourceShowing(creatingScheme, creatingInAgents, shownRef.current);
    if (isTreeTab(source)) showTab(source);
    setPicked(source);
  }, [creatingScheme, creatingInAgents, showTab]);
  const changes = useChangesScope(projectId, chatThreadId);
  const changesShown = changes.offered || picked === "changes";
  const tabs = useMemo<readonly SourceKey[]>(
    () => ["chat", ...chosen, ...(changesShown ? ["changes" as const] : [])],
    [chosen, changesShown],
  );
  const fallback: SourceKey = mainChat
    ? "chat"
    : (tabs.find((key) => key === activeScheme) ?? chosen[0] ?? "chat");
  const foot = FOOT_SOURCES.filter((key) => key !== "scratch" || scratchWorkId);
  const source =
    tabs.includes(picked) || (foot as readonly SourceKey[]).includes(picked) ? picked : fallback;
  if (source !== picked) setPicked(source);
  const changesDrafts = useMemo(() => changes.drafts.map((draft) => draft.id), [changes.drafts]);
  const changesCommands = usePressCommands({
    projectId,
    work: changes.work,
    drafts: changesDrafts,
    surface: "changes",
  });

  const shell = useShellTreeVersion();
  const version = shell?.version ?? LIVE_VERSION;
  const drafting = shell?.showing === "draft";
  const catalogs = useProjectTreeViews(projectId, TREE_SCHEMES, {
    workId: scratchWorkId,
    enabled: contextLive,
    version,
  });
  const mainTree = activeScheme && isTreeKey(activeScheme) ? activeScheme : null;
  const activePath =
    mainTree === "user" && activeDocumentId
      ? (catalogs.user.tree?.findDocument(activeDocumentId)?.path ?? null)
      : null;
  const placed = mainTree !== "user" || activePath !== null;
  const inAgents = mainTree !== null && listedInAgents(mainTree, activePath ?? "");
  useEffect(() => {
    if (mainTree && placed) follow(sourceShowing(mainTree, inAgents, shownRef.current));
  }, [mainTree, placed, inAgents, follow]);
  const placedIn = useRef<(folderId: string) => void>(() => undefined);
  placedIn.current = (folderId) => {
    for (const scheme of TREE_SCHEMES) {
      const tree = catalogs[scheme].tree;
      const path = tree?.root.entryId === folderId ? "" : tree?.entry(folderId)?.path;
      if (path === undefined) continue;
      follow(sourceShowing(scheme, listedInAgents(scheme, path), shownRef.current));
      return;
    }
  };
  useEffect(() => subscribePlacedReveal((folderId) => placedIn.current(folderId)), []);
  const undo = useSidebarUndo(projectId, version);
  const { openDraftFile } = useItemLauncher();
  const selectFile = useCallback<WriteSources["onSelectFile"]>(
    (scheme, file, options) => {
      const draft = drafting && shell ? shell.draftOf(file.documentId) : null;
      if (!draft || !shell) return onSelectFile(scheme, file, options);
      openDraftFile(draft, shell.draftId);
      onPicked?.();
    },
    [drafting, shell, onSelectFile, openDraftFile, onPicked],
  );
  const ended = version.ended === "deleted";
  const writable = useMemo(
    () =>
      Object.fromEntries(
        TREE_SCHEMES.map((scheme) => [scheme, !ended && (scheme !== "scratch" || scratchWritable)]),
      ) as Record<TreeKey, boolean>,
    [scratchWritable, ended],
  );
  const areas = useMemo<MoveArea[]>(
    () =>
      TREE_SCHEMES.flatMap((scheme) => {
        const tree = catalogs[scheme].tree;
        return tree
          ? [
              {
                scheme,
                owner: { workId: editorWorkId },
                tree,
                writable: writable[scheme],
                ...(drafting && shell
                  ? {
                      view: {
                        kind: "draft" as const,
                        draft: shell.draftId,
                      },
                    }
                  : {}),
              },
            ]
          : [];
      }),
    [catalogs, editorWorkId, writable, drafting, shell],
  );
  const list = useEntryList({ projectId, areas });
  const dropImport = useOptionalImports()?.drop;
  const files = useMemo<FilesRoute>(
    () => ({
      verdict: (target) => {
        const destination = destinationOf(target.scheme, target.folder);
        return destination ? { kind: "accept", label: t`Import into ${destination.name}` } : null;
      },
      drop: (target, items) => {
        const destination = destinationOf(target.scheme, target.folder);
        if (!destination || !dropImport) return;
        dropImport(destination, items);
        revealPlaced(target.folder?.entryId ?? target.treeRootId, [], null);
      },
    }),
    [dropImport],
  );
  const value = useMemo<WriteSources>(
    () => ({
      projectId,
      scopeWorkId,
      chatThreadId,
      editorWorkId,
      activeScheme,
      activeDocumentId,
      onSelectFile: selectFile,
      onPicked,
      catalogs,
      writable,
      changes,
      changesCommands,
    }),
    [
      projectId,
      scopeWorkId,
      chatThreadId,
      editorWorkId,
      activeScheme,
      activeDocumentId,
      selectFile,
      onPicked,
      catalogs,
      writable,
      changes,
      changesCommands,
    ],
  );

  return (
    <WriteSourcesContext.Provider value={value}>
      <EntryList list={list} files={files}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hears Ctrl+Z from anywhere inside; a click on its blank space or a heading focuses it (tabIndex -1), so the sidebar's Undo needs no row focused. slop-lint: allow suppression the reason is stated in this comment */}
        <div
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col outline-none"
          onKeyDown={(event) => {
            const root = isTreeKey(source) ? catalogs[source].tree?.root.entryId : undefined;
            if (source === "changes" && undo.handles(event)) undo.press(false, null);
            else if (root && undo.handles(event)) undo.press(source === "user", root);
          }}
        >
          <SourceTabs
            projectId={projectId}
            chosen={chosen}
            tabs={tabs}
            source={source}
            onSelect={setPicked}
          />
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              drafting && isTreeKey(source) && "bg-review",
            )}
          >
            <SourceView key={source} source={source} />
          </div>
          <div className="shrink-0 px-2 pt-1">
            {foot.map((key) => (
              <FootSource
                key={key}
                source={key}
                current={key === source}
                onSelect={() => setPicked(key)}
              />
            ))}
          </div>
        </div>
      </EntryList>
    </WriteSourcesContext.Provider>
  );
}

function SourceView({ source }: { source: SourceKey }) {
  const { useDrop, Body } = SOURCES[source];
  const drop = useDrop();
  return <Body drop={drop} />;
}

function SourceTabs({
  projectId,
  chosen,
  tabs,
  source,
  onSelect,
}: {
  projectId: string;
  chosen: readonly TreeTab[];
  tabs: readonly SourceKey[];
  source: SourceKey;
  onSelect: (key: SourceKey) => void;
}) {
  const toggle = useSidebarTabs((state) => state.toggle);
  const keys = tabListKeys(tabs, source, onSelect);
  const tab = (key: SourceKey) => (
    <SourceTab
      key={key}
      source={key}
      active={key === source}
      tabIndex={keys.tabIndex(key)}
      onSelect={() => onSelect(key)}
    />
  );
  return (
    <div className="flex shrink-0 items-center px-2 py-1 coarse:px-1">
      <div
        role="tablist"
        aria-label={t`Sources`}
        onKeyDown={keys.onKeyDown}
        className="-m-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-1 coarse:gap-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tab("chat")}
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border coarse:mx-0.5" />
        {chosen.map(tab)}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="sm"
              label={t`Choose tabs`}
              tooltipSide="bottom"
              className="size-7 shrink-0 coarse:size-11"
            >
              <Ellipsis aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>{t`Tabs`}</DropdownMenuLabel>
            {TREE_TABS.map((key) => {
              const Icon = SOURCES[key].icon;
              return (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={chosen.includes(key)}
                  onSelect={(event) => {
                    event.preventDefault();
                    toggle(key);
                  }}
                >
                  <Icon className="size-4" aria-hidden />
                  {SOURCES[key].label()}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {tabs.includes("changes") ? <span className="ml-auto">{tab("changes")}</span> : null}
      </div>
      <TreeVersionChip projectId={projectId} />
    </div>
  );
}

function TreeVersionChip({ projectId }: { projectId: string }) {
  const shell = useShellTreeVersion();
  const touch = useCoarsePointer();
  const menu = useWorkDraftMenu(
    projectId,
    shell,
    (draftId) => shell?.showing === "draft" && draftId === shell.draftId,
  );
  if (!shell?.offered) return null;
  return (
    <DraftSwitcher
      label={t`Sidebar version`}
      showing={shell.showing}
      owner={menu?.owner}
      drafts={
        menu?.drafts ?? [
          {
            key: shell.draftId,
            name: <WorkIdentity work={shell.work} unavailableLabel={t`This chat`} />,
            current: shell.showing === "draft",
            scope: true,
            onSelect: () => shell.show("draft"),
          },
        ]
      }
      onShowLive={() => shell.show("live")}
      onNewDraft={menu?.onNewDraft}
      onDeleteDraft={menu?.onDeleteDraft}
      touch={touch}
    />
  );
}

function FootSource({
  source,
  current,
  onSelect,
}: {
  source: (typeof FOOT_SOURCES)[number];
  current: boolean;
  onSelect: () => void;
}) {
  const { label, icon, useDrop } = SOURCES[source];
  const { catalogs } = useWriteSources();
  const count = source === "unfiled" ? (catalogs.unfiled.tree?.files().length ?? 0) : 0;
  const drop = useDrop(onSelect);
  return (
    <DropRegion state={drop.dropState} flush>
      <div {...drop.dropProps}>
        <ListRow
          icon={icon}
          title={label()}
          meta={count > 0 ? count : undefined}
          current={current}
          onOpen={onSelect}
        />
      </div>
    </DropRegion>
  );
}

const TAB_BUTTON =
  "focus-ring grid size-7 shrink-0 place-items-center rounded-md transition-colors coarse:size-11";

function SourceTab({
  source,
  active,
  tabIndex,
  onSelect,
}: {
  source: SourceKey;
  active: boolean;
  tabIndex: number;
  onSelect: () => void;
}) {
  const { label, title, badge, icon: Icon, useDrop } = SOURCES[source];
  const sources = useWriteSources();
  const name = title?.(sources) ?? label();
  const count = badge?.(sources) ?? 0;
  const drop = useDrop(onSelect);
  const self = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={self}
          type="button"
          role="tab"
          data-tab-value={source}
          tabIndex={tabIndex}
          aria-selected={active}
          aria-label={count > 0 ? t`${name}, ${count} to review` : name}
          onClick={onSelect}
          {...drop.dropProps}
          className={cn(
            TAB_BUTTON,
            "relative",
            drop.dropState === "over"
              ? role.dropTarget
              : active
                ? role.selected
                : cn(role.secondary, role.hover, "hover:text-foreground"),
          )}
        >
          <Icon className="size-4" aria-hidden />
          {count > 0 ? (
            <Chip kind="badge" aria-hidden className="-top-1 -right-1 absolute">
              {count}
            </Chip>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{name}</TooltipContent>
    </Tooltip>
  );
}
