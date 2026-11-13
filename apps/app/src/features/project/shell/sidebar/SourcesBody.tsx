import { t } from "@lingui/core/macro";
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
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useWorks } from "@/client/query/useWorks";
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
import {
  useWorkBranchCommands,
  type WorkBranchCommands,
} from "@/features/draft-review/useWorkBranchCommands";
import { destinationOf } from "@/features/import/destination";
import { useOptionalImports } from "@/features/import/ImportProvider";
import { cn } from "@/lib/utils";
import { RailScratchSection } from "../../chat/ChatScratch";
import { type CatalogState, ContextTreePanel } from "../../context/ContextTreePanel";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "../../context/context-schemes";
import type { MoveArea } from "../../context/entry-drag/move-plan";
import { EntryList, useEntryList } from "../../context/entry-drag/use-entry-list";
import { useOptionalTreeCreation } from "../../context/TreeCreationProvider";
import { DropRegion } from "../../context/tree-drop/DropRegion";
import { type FilesRoute, useTreeDropTarget } from "../../context/tree-drop/tree-drop";
import { useChatNavigation } from "../../routing/chat-navigation";
import { useTrashNavigation } from "../../routing/ProjectNavigationContext";
import { type ChangesScope, ChangesSource, useChangesScope } from "./ChangesSource";
import { ChatsBody } from "./ChatsBody";
import type { SourceDrop } from "./SourcePane";
import { TREE_TABS, type TreeTab, useSidebarTabs } from "./sidebar-tabs-store";
import { TrashSource } from "./TrashSource";
import { useTrashDrop } from "./trash-drop";

type TreeKey = (typeof EDITOR_CONTEXT_SCHEMES)[number];

/**
 * Every pane the sidebar can show: the strip's Chat, tree tabs and Changes, and the quiet rows
 * at its foot, Unfiled and Trash.
 */
type SourceKey = "chat" | TreeTab | "unfiled" | "trash" | "changes";
const FOOT_SOURCES = ["unfiled", "trash"] as const satisfies readonly SourceKey[];

type WriteSources = {
  projectId: string;
  /** The Work picker's scope, whose chats the Chat list shows first. */
  scopeWorkId: string | null;
  /** The chat on screen: its row reads as current, Scratch follows it, Changes asks of it. */
  chatThreadId: string | null;
  /** Shell-resolved Editor Work; the tree never derives scope from Chat. */
  editorWorkId: string | null;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSelectFile: (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => void;
  /** After a pick that opens something elsewhere (the phone drawer closes). */
  onPicked?: () => void;
  catalogs: Record<TreeKey, CatalogState>;
  changes: ChangesScope;
  /** Held here, not in the pane, so a Discard's Undo outlives a look at another tab. */
  changesCommands: WorkBranchCommands;
};

const WriteSourcesContext = createContext<WriteSources | null>(null);

function useWriteSources(): WriteSources {
  const sources = useContext(WriteSourcesContext);
  if (!sources) throw new Error("A source needs SourcesBody");
  return sources;
}

/**
 * One sidebar source. `useDrop` is the drop at the source's root, used by its
 * tab (where `reveal` shows the source) and by its pane; `Body` is its pane.
 */
type Source = {
  label: () => string;
  /** The tab's name when it says more than the label (whose changes). */
  title?: (sources: WriteSources) => string;
  /** A count on the tab of what waits on the writer; 0 shows none. */
  badge?: (sources: WriteSources) => number;
  icon: LucideIcon;
  useDrop: (reveal?: () => void) => SourceDrop;
  Body: ComponentType<{ drop: SourceDrop }>;
};

/** A drop at a catalog's top level; a drag resting on it accepted shows the source. */
function useRootDrop(scheme: TreeKey, reveal?: () => void): SourceDrop {
  const rootId = useWriteSources().catalogs[scheme].catalog?.root.entryId ?? null;
  const target = useMemo(
    () => ({ scheme, catalogRootId: rootId ?? `${scheme}:loading`, folder: null }),
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
          catalogState={sources.catalogs[scheme]}
          projectId={sources.projectId}
          editorWorkId={sources.editorWorkId}
          activeScheme={sources.activeScheme}
          activePath={sources.activePath}
          onSelectFile={sources.onSelectFile}
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
          // The drawer closes once the navigation commits: a rejected one leaves it open.
          onOpenChat={(threadId) => void chat.openChat(threadId).then(() => onPicked?.())}
          onNewChat={() => void chat.openNewChat().then(() => onPicked?.())}
          // Scratch lives with its chat. Renders nothing while no chat is open.
          footer={
            <RailScratchSection projectId={projectId} threadId={chatThreadId} onPicked={onPicked} />
          }
        />
      );
    },
  },
  manuscript: treeSource("manuscript"),
  kb: treeSource("kb"),
  user: treeSource("user"),
  unfiled: treeSource("unfiled"),
  trash: {
    label: () => t`Trash`,
    icon: Trash2,
    // Dropping deletes, so the drag needs no look at Trash first.
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
      const { projectId, changes, changesCommands, activeScheme, activePath, onPicked } =
        useWriteSources();
      return (
        <ChangesSource
          // A question asked of one Work must not be answered for the next one picked.
          key={changes.ownerKey}
          projectId={projectId}
          scope={changes}
          controller={changesCommands}
          isOpen={(file) =>
            file.contextLocation?.scheme === activeScheme &&
            file.contextLocation?.path === activePath
          }
          onPicked={onPicked}
        />
      );
    },
  },
};

/** A source nothing is dropped on. */
const IDLE_DROP: SourceDrop = { dropProps: {}, dropState: "idle" };

function isTreeTab(key: string): key is TreeTab {
  return (TREE_TABS as readonly string[]).includes(key);
}

/** Where a document of this scheme is listed: its tree's tab, Unfiled, or Scratch under its chat. */
function sourceOfScheme(scheme: ProjectContextTreeScheme): SourceKey | null {
  if (isTreeTab(scheme) || scheme === "unfiled") return scheme;
  return scheme === "scratch" ? "chat" : null;
}

/**
 * The sidebar's sources, on the desktop sidebar and the phone drawer: one pane at a time behind
 * a strip of tabs, so each list gets the full height. The strip is Chat, then the tree sources
 * the writer chose (+ picks them), then Changes while it has something to offer. Unfiled and
 * Trash sit as quiet rows at the foot and show their pane the same way. Tabs are icons named on
 * hover; the pane names its source. Main's item's source becomes the shown one when it changes
 * (a document's tree, Trash for a deleted one, the Chat list for a chat), unless Changes is
 * shown. The strip, the foot and every pane are one list: one selection, and a row dragged
 * anywhere in the sidebar drops on any tab, row or pane.
 */
export function SourcesBody({
  projectId,
  scopeWorkId,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeScheme,
  activePath,
  onSelectFile,
  onPicked,
}: Omit<WriteSources, "catalogs" | "changes" | "changesCommands"> & {
  contextLive: boolean;
}) {
  const chosen = useSidebarTabs((state) => state.shown);
  useEffect(() => {
    void useSidebarTabs.persist.rehydrate();
  }, []);
  const showTab = useSidebarTabs((state) => state.show);
  const mainChat = useChatNavigation().display;
  const mainChatKey = mainChat ? (mainChat.kind === "thread" ? mainChat.threadId : "new") : null;
  const [picked, setPicked] = useState<SourceKey>(mainChat ? "chat" : "manuscript");
  // Changes stays: it is the list the writer opens drafts from, whatever tree they live in.
  // `picked` is Changes only while it is shown (see below).
  const follow = useCallback(
    (source: SourceKey) => {
      if (isTreeTab(source)) showTab(source);
      setPicked((current) => (current === "changes" ? current : source));
    },
    [showTab],
  );
  useEffect(() => {
    const source = activeScheme && sourceOfScheme(activeScheme);
    if (source) follow(source);
  }, [activeScheme, follow]);
  useEffect(() => {
    if (mainChatKey) follow("chat");
  }, [mainChatKey, follow]);
  // A deleted document main shows is Trash's, so Trash shows, as a document shows its tree.
  const trashShown = useTrashNavigation().shown;
  useEffect(() => {
    if (trashShown) follow("trash");
  }, [trashShown, follow]);
  // A new file or folder asked for elsewhere (the empty Editor) appears in its source.
  const creatingScheme = useOptionalTreeCreation()?.request?.scheme;
  useEffect(() => {
    const source = creatingScheme && sourceOfScheme(creatingScheme);
    if (!source) return;
    if (isTreeTab(source)) showTab(source);
    setPicked(source);
  }, [creatingScheme, showTab]);
  const changes = useChangesScope(projectId, chatThreadId);
  // Under None, Changes is offered only while the chat on screen has drafts, but it stays
  // while it is the pane on show, so emptying it keeps the last command's Undo in view.
  const changesShown = changes.offered || picked === "changes";
  const tabs = useMemo<readonly SourceKey[]>(
    () => ["chat", ...chosen, ...(changesShown ? ["changes" as const] : [])],
    [chosen, changesShown],
  );
  // A tab that left the strip can't stay selected: main's item's source shows, else the first
  // tree tab, else Chat.
  const fallback: SourceKey = mainChat
    ? "chat"
    : (tabs.find((key) => activeScheme !== null && key === sourceOfScheme(activeScheme)) ??
      chosen[0] ??
      "chat");
  const source =
    tabs.includes(picked) || (FOOT_SOURCES as readonly SourceKey[]).includes(picked)
      ? picked
      : fallback;
  if (source !== picked) setPicked(source);
  const changesCommands = useWorkBranchCommands({
    projectId,
    work: changes.work,
    ownerKey: changes.ownerKey,
    surface: "changes",
  });

  const catalogs = useContextCatalogViews(projectId, EDITOR_CONTEXT_SCHEMES, {
    workId: editorWorkId,
    enabled: contextLive,
  });
  const areas = useMemo<MoveArea[]>(
    () =>
      EDITOR_CONTEXT_SCHEMES.flatMap((scheme) => {
        const catalog = catalogs[scheme].catalog;
        return catalog ? [{ scheme, owner: { workId: editorWorkId }, catalog, accepts: true }] : [];
      }),
    [catalogs, editorWorkId],
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
        if (destination) dropImport?.(destination, items);
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
      activePath,
      onSelectFile,
      onPicked,
      catalogs,
      changes,
      changesCommands,
    }),
    [
      projectId,
      scopeWorkId,
      chatThreadId,
      editorWorkId,
      activeScheme,
      activePath,
      onSelectFile,
      onPicked,
      catalogs,
      changes,
      changesCommands,
    ],
  );

  return (
    <WriteSourcesContext.Provider value={value}>
      <EntryList list={list} files={files}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SourceTabs chosen={chosen} tabs={tabs} source={source} onSelect={setPicked} />
          <SourceView key={source} source={source} />
          <div className="shrink-0 px-2 pt-1">
            {FOOT_SOURCES.map((key) => (
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

/** The shown source's pane; keyed by source, so each source's drop hook keeps its own place. */
function SourceView({ source }: { source: SourceKey }) {
  const { useDrop, Body } = SOURCES[source];
  const drop = useDrop();
  return <Body drop={drop} />;
}

function SourceTabs({
  chosen,
  tabs,
  source,
  onSelect,
}: {
  /** The writer's tree tabs, which the ⋯ menu shows and changes. */
  chosen: readonly TreeTab[];
  /** The tabs on the strip now: Chat, the chosen trees, and Changes while it is offered. */
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
            {/* Sized like the tabs it sits among. */}
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
        {tabs.includes("changes") ? <span className="ml-auto flex">{tab("changes")}</span> : null}
      </div>
    </div>
  );
}

/** A quiet row at the sidebar's foot that shows its source's pane, and takes drops as its tab would. */
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
  const count = source === "unfiled" ? (catalogs.unfiled.catalog?.files().length ?? 0) : 0;
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

/**
 * A tab, like the strip's + button: 28px, 44px under a finger. With a mouse every tab and +
 * fit a default-width sidebar; under a finger six tabs and + fill the 320px phone drawer only
 * because the row drops its gaps and half its inset. More tabs, or a narrower sidebar, scroll
 * the strip.
 */
const TAB_BUTTON =
  "focus-ring grid size-7 shrink-0 place-items-center rounded-md transition-colors coarse:size-11";

/** A source's tab: a drop on it lands at the source's root, and a drag that rests opens it. */
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
  // The strip scrolls when its tabs outgrow the sidebar: keep the selected one in view.
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
