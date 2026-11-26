import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, type LucideIcon, MessageSquare, Plus, X } from "lucide-react";
import {
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type WheelEvent,
} from "react";
import { useLiveTabs } from "@/client/project-shell/live-tabs";
import {
  closeAllMainTabs,
  closeMainTab,
  type MainTab,
  type MainTabKind,
  mainTabKey,
} from "@/client/project-shell/main-tabs";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { OpenDocument } from "@/client/stores";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatTitle } from "@/features/chat/ChatThreadTitle";
import { draftCopyView } from "@/features/draft-review/copy-view";
import { useScrollEdges } from "@/hooks/use-scroll-edges";
import { holdFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { useAccountId } from "../context/account-feature-context";
import { documentPlace } from "../context/context-schemes";
import { useReferenceDrag } from "../context/entry-drag/reference-source";
import { tabSubject } from "../context/tab-subject";
import { useChatNavigation } from "../routing/chat-navigation";
import {
  type OpenContextRoute,
  useProjectRouteCommands,
} from "../routing/ProjectNavigationContext";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { useDocumentPaint } from "../views";
import { BandIconButton } from "./BandIconButton";
import { tabChipClass } from "./tab-chip";

export function useMainTabCommands({
  projectId,
  kind,
  open,
  mainKey,
}: {
  projectId: string;
  kind: MainTabKind;
  open: OpenContextRoute;
  mainKey: string | null;
}) {
  const { showEditorRecents } = useProjectRouteCommands();
  const accountId = useAccountId();
  const openInMain = useOpenInMain(projectId, open);
  const chat = useChatNavigation();
  const { lanes } = useLiveTabs();
  const lane = lanes[kind];
  const select = useCallback(
    (tab: MainTab, options?: { replace: boolean }) => {
      if (tab.kind === "document") void openInMain(tab.document, options);
      else void chat.openChat(tab.chatId, options);
    },
    [openInMain, chat],
  );
  const showEmpty = useCallback(
    () =>
      kind === "document"
        ? showEditorRecents({ replace: true })
        : chat.openNewChat({ replace: true }),
    [kind, showEditorRecents, chat],
  );
  const show = useCallback(
    (tab: MainTab | null) => (tab ? select(tab, { replace: true }) : void showEmpty()),
    [select, showEmpty],
  );
  return {
    select,
    close: (tab: MainTab) => {
      const key = mainTabKey(tab);
      const next = closeMainTab(accountId, projectId, kind, key, mainKey, lane.tabs);
      if (key === mainKey) show(next);
    },
    closeAll: async ({ keepMain }: { keepMain: boolean }) => {
      if (!keepMain) await showEmpty();
      closeAllMainTabs(accountId, projectId, kind);
    },
    closeMain: () => {
      const { tabs, selected } = lane;
      show(tabs.find((tab) => mainTabKey(tab) === selected) ?? tabs.at(-1) ?? null);
    },
  };
}

export function MainTabStrip({
  projectId,
  kind,
  open,
  mainTab,
  current,
  onNew,
}: {
  projectId: string;
  kind: MainTabKind;
  open: OpenContextRoute;
  mainTab?: MainTab;
  current?: ReactNode;
  onNew?: () => void;
}) {
  const mainKey = mainTab ? mainTabKey(mainTab) : null;
  const { tabs, unrecorded } = useDrawnTabs(kind, mainTab);
  const commands = useMainTabCommands({ projectId, kind, open, mainKey });
  const documents = [...tabs, ...(unrecorded ? [unrecorded] : [])]
    .filter((tab): tab is Extract<MainTab, { kind: "document" }> => tab.kind === "document")
    .map((tab) => tab.document);
  const stripRef = useRef<HTMLDivElement>(null);
  const more = useScrollEdges(stripRef);
  useActiveTabVisibility(stripRef, mainKey ?? (current ? "current" : null));
  const lastActive =
    unrecorded !== undefined || (tabs.at(-1) && mainTabKey(tabs.at(-1) as MainTab) === mainKey);
  const chip = (tab: MainTab, active: boolean, divider: boolean) =>
    tab.kind === "document" ? (
      <DocumentTabChip
        key={mainTabKey(tab)}
        projectId={projectId}
        document={tab.document}
        documents={documents}
        active={active}
        divider={divider}
        onSelect={() => commands.select(tab)}
        onClose={() => commands.close(tab)}
      />
    ) : (
      <ChatTabChip
        key={mainTabKey(tab)}
        projectId={projectId}
        chatId={tab.chatId}
        active={active}
        divider={divider}
        onSelect={() => commands.select(tab)}
        onClose={() => commands.close(tab)}
      />
    );
  const newLabel = kind === "document" ? t`New document` : t`New chat`;
  return (
    <div
      role="tablist"
      aria-label={kind === "document" ? t`Open documents` : t`Open chats`}
      data-main-tab-strip
      onKeyDown={moveAlongStrip}
      className="flex h-full min-w-0 shrink items-stretch"
    >
      {/* The padding is room for the end tabs' flares, which this scroller would clip; the
          negative margins take it back, so the first tab starts where the chip before it ends. */}
      <div
        ref={stripRef}
        onWheel={scrollStripWithWheel}
        data-more-start={more.start || undefined}
        data-more-end={more.end || undefined}
        className="-mx-1.5 flex min-w-0 scroll-fade-x items-stretch overflow-x-auto overflow-y-hidden px-1.5 [--scroll-fade:1.5rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const active = mainTabKey(tab) === mainKey;
          const previous = tabs[index - 1];
          return chip(
            tab,
            active,
            !active && previous !== undefined && mainTabKey(previous) !== mainKey,
          );
        })}
        {unrecorded ? chip(unrecorded, true, false) : null}
        {current ? (
          <div
            data-active-tab
            data-main-current
            className="flex max-w-60 shrink-0 scroll-mx-6 items-stretch"
          >
            {current}
          </div>
        ) : null}
      </div>
      {/* New follows the lane's tabs only: after main's other item (a removed page) it would read
          as a new one of those. */}
      {current ? null : (
        <BandIconButton
          label={newLabel}
          tooltip={onNew ? undefined : t`Open a Work to create an Untitled document`}
          aria-disabled={!onNew || undefined}
          onClick={onNew}
          className="aria-disabled:opacity-50"
        >
          {tabs.length > 0 && !lastActive ? (
            <span
              aria-hidden
              className="absolute top-1/2 -left-1 h-3.5 w-px -translate-y-1/2 bg-border"
            />
          ) : null}
          <Plus aria-hidden />
        </BandIconButton>
      )}
    </div>
  );
}

export function MainTabMenu({
  projectId,
  kind,
  open,
  mainTab,
  keepMain,
}: {
  projectId: string;
  kind: MainTabKind;
  open: OpenContextRoute;
  mainTab?: MainTab;
  keepMain: boolean;
}) {
  const mainKey = mainTab ? mainTabKey(mainTab) : null;
  const { tabs, unrecorded } = useDrawnTabs(kind, mainTab);
  const commands = useMainTabCommands({ projectId, kind, open, mainKey });
  // Each document's page has its own band, so the trigger Radix would refocus is gone.
  const focusAfter = useRef<(() => HTMLElement | null) | null>(null);
  const listed = unrecorded ? [...tabs, unrecorded] : tabs;
  if (listed.length === 0) return null;
  const label = kind === "document" ? t`All open documents` : t`All open chats`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <BandIconButton label={label} className="ml-auto">
          <ChevronDown aria-hidden />
        </BandIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 max-w-[calc(100vw-1rem)]"
        onCloseAutoFocus={(event) => {
          const target = focusAfter.current;
          if (!target) return;
          focusAfter.current = null;
          event.preventDefault();
          holdFocus(target);
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            focusAfter.current = () =>
              window.document.querySelector<HTMLElement>("[data-recents-door]");
            void commands.closeAll({ keepMain });
          }}
        >
          <Trans>Close all</Trans>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {listed.map((tab) => (
          <TabMenuItem
            key={mainTabKey(tab)}
            projectId={projectId}
            tab={tab}
            active={mainTabKey(tab) === mainKey}
            onSelect={() => {
              focusAfter.current = () => selectedTabFor(mainTabKey(tab));
              commands.select(tab);
            }}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabMenuItem({
  projectId,
  tab,
  active,
  onSelect,
}: {
  projectId: string;
  tab: MainTab;
  active: boolean;
  onSelect: () => void;
}) {
  return tab.kind === "document" ? (
    <DropdownMenuItem
      selected={active}
      onSelect={onSelect}
      title={tab.document.kind === "new" ? tab.document.name : tab.document.path}
    >
      <span className="min-w-0 truncate">{tab.document.name}</span>
    </DropdownMenuItem>
  ) : (
    <ChatMenuItem projectId={projectId} chatId={tab.chatId} active={active} onSelect={onSelect} />
  );
}

function ChatMenuItem({
  projectId,
  chatId,
  active,
  onSelect,
}: {
  projectId: string;
  chatId: string;
  active: boolean;
  onSelect: () => void;
}) {
  const title = useChatTitle(projectId, chatId);
  return (
    <DropdownMenuItem selected={active} onSelect={onSelect}>
      <span className="min-w-0 truncate">{title}</span>
    </DropdownMenuItem>
  );
}

function useDrawnTabs(kind: MainTabKind, mainTab?: MainTab) {
  const { lanes, project } = useLiveTabs();
  const lane = lanes[kind].tabs;
  const mainKey = mainTab ? mainTabKey(mainTab) : null;
  const unrecorded =
    mainTab && mainTab.kind === kind && !lane.some((tab) => mainTabKey(tab) === mainKey)
      ? mainTab.kind === "document"
        ? ({ kind: "document", document: project(mainTab.document) } as const)
        : mainTab
      : undefined;
  return { tabs: lane, unrecorded };
}

function DocumentTabChip({
  projectId,
  document,
  documents,
  active,
  divider,
  onSelect,
  onClose,
}: {
  projectId: string;
  document: OpenDocument;
  documents: OpenDocument[];
  active: boolean;
  divider: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const paint = useDocumentPaint(projectId, active ? document : null);
  const drafts = useOwnerDrafts(projectId, paint.draft?.draftId ?? null);
  const file = paint.draft ? drafts.fileForDocument(document.documentId) : null;
  const reviewing = active && paint.draft !== null;
  const drag = useReferenceDrag(
    tabSubject(document, {
      reviewing,
      view: file && paint.draft ? draftCopyView(file, paint.draft.draftId) : null,
    }),
  );
  const heldWidth = useHeldTabWidth();
  const closeByPointer = (chip: HTMLElement | null) => {
    holdTabWidth(chip);
    onClose();
  };
  const key = mainTabKey({ kind: "document", document });
  const place = document.kind === "new" ? null : documentPlace(document.scheme, document.path);
  const peers = documents.filter(
    (other) => other.documentId !== document.documentId && other.name === document.name,
  );
  const samePlace =
    place !== null &&
    peers.some(
      (other) => other.kind !== "new" && documentPlace(other.scheme, other.path) === place,
    );
  const name =
    samePlace && document.kind !== "new"
      ? (document.path.split("/").pop() ?? document.name)
      : document.name;
  const label = peers.length && place ? `${name}, ${place}` : name;
  return (
    <TabChipFrame
      active={active}
      surface={reviewing ? "review" : "page"}
      divider={divider}
      tabProps={{
        ...drag,
        style: heldWidth === null ? undefined : { flex: `0 0 ${heldWidth}px` },
        onAuxClick: (event) => {
          if (event.button === 1) closeByPointer(event.currentTarget);
        },
      }}
      className={cn("@container/tab w-60 shrink", active ? "min-w-16" : "min-w-12")}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={label}
        tabIndex={active ? 0 : -1}
        data-main-tab={key}
        onClick={(event) => {
          const focused = event.currentTarget === window.document.activeElement;
          onSelect();
          // Each document's page has its own band: the focus follows to this tab in the new one.
          if (focused) holdFocus(() => selectedTabFor(key));
        }}
        className="focus-ring absolute inset-0"
        title={document.kind === "new" ? document.name : document.path}
      />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left text-xs">
        {name}
        {peers.length > 0 && place && <span className="text-muted-foreground"> {place}</span>}
      </span>
      <TabCloseButton
        name={label}
        active={active}
        onClose={(event) =>
          event.detail > 0 ? closeByPointer(event.currentTarget.parentElement) : onClose()
        }
      />
    </TabChipFrame>
  );
}

function ChatTabChip({
  projectId,
  chatId,
  active,
  divider,
  onSelect,
  onClose,
}: {
  projectId: string;
  chatId: string;
  active: boolean;
  divider: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const title = useChatTitle(projectId, chatId);
  const heldWidth = useHeldTabWidth();
  const closeByPointer = (chip: HTMLElement | null) => {
    holdTabWidth(chip);
    onClose();
  };
  return (
    <TabChipFrame
      active={active}
      divider={divider}
      tabProps={{
        style: heldWidth === null ? undefined : { flex: `0 0 ${heldWidth}px` },
        onAuxClick: (event) => {
          if (event.button === 1) closeByPointer(event.currentTarget);
        },
      }}
      className={cn("@container/tab w-60 shrink", active ? "min-w-16" : "min-w-12")}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={title}
        tabIndex={active ? 0 : -1}
        data-main-tab={mainTabKey({ kind: "chat", chatId })}
        onClick={onSelect}
        className="focus-ring absolute inset-0"
        title={title}
      />
      <MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left text-xs">
        {title}
      </span>
      <TabCloseButton
        name={title}
        active={active}
        onClose={(event) =>
          event.detail > 0 ? closeByPointer(event.currentTarget.parentElement) : onClose()
        }
      />
    </TabChipFrame>
  );
}

export function UntabbedChip({
  icon: Icon,
  name,
  onClose,
}: {
  icon: LucideIcon;
  name: string;
  onClose: () => void;
}) {
  return (
    <TabChipFrame active divider={false}>
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        role="tab"
        aria-selected
        tabIndex={-1}
        className="min-w-0 flex-1 truncate text-left text-xs"
      >
        {name}
      </span>
      <TabCloseButton name={name} active onClose={onClose} />
    </TabChipFrame>
  );
}

function TabCloseButton({
  name,
  active,
  onClose,
}: {
  name: string;
  active: boolean;
  onClose: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={t`Close ${name}`}
      tabIndex={active ? 0 : -1}
      className={cn(
        "focus-ring relative grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground",
        "hover:bg-ink-fill hover:text-foreground",
        !active && "@max-[2.5rem]/tab:hidden",
      )}
    >
      <X className="size-3" aria-hidden />
    </button>
  );
}

let heldTabWidth: number | null = null;
const heldTabWidthListeners = new Set<() => void>();

function setHeldTabWidth(width: number | null) {
  if (width === heldTabWidth) return;
  heldTabWidth = width;
  for (const listener of heldTabWidthListeners) listener();
}

function holdTabWidth(chip: HTMLElement | null) {
  if (!chip) return;
  const first = heldTabWidth === null;
  const inactive = chip
    .closest("[data-main-tab-strip]")
    ?.querySelector('[role=tab][aria-selected="false"]')?.parentElement;
  setHeldTabWidth((inactive ?? chip).getBoundingClientRect().width);
  if (!first) return;
  const inStrip = (node: EventTarget | null) =>
    node instanceof Element && node.closest("[data-main-tab-strip]") !== null;
  const release = (event: PointerEvent) => {
    const crossedOut =
      event.type === "pointerover" && !inStrip(event.target) && inStrip(event.relatedTarget);
    const pressedElsewhere = event.type === "pointerdown" && !inStrip(event.target);
    const leftWindow =
      event.type === "pointerout" &&
      event.pointerType === "mouse" &&
      event.relatedTarget === null &&
      inStrip(event.target);
    if (!crossedOut && !pressedElsewhere && !leftWindow) return;
    for (const type of RELEASE_EVENTS) window.removeEventListener(type, release, true);
    setHeldTabWidth(null);
  };
  for (const type of RELEASE_EVENTS) window.addEventListener(type, release, true);
}

const RELEASE_EVENTS = ["pointerover", "pointerdown", "pointerout"] as const;

function useHeldTabWidth(): number | null {
  return useSyncExternalStore(
    (listener) => {
      heldTabWidthListeners.add(listener);
      return () => heldTabWidthListeners.delete(listener);
    },
    () => heldTabWidth,
    () => null,
  );
}

/**
 * Keeps the active chip inside the strip's viewport. The router's scroll restoration also records
 * this scroller and writes a stale offset back after each navigation, so the reveal runs again
 * once the router has rendered.
 */
function useActiveTabVisibility(
  stripRef: RefObject<HTMLDivElement | null>,
  activeKey: string | null,
) {
  const router = useRouter();
  useEffect(() => {
    const reveal = () =>
      stripRef.current
        ?.querySelector("[data-active-tab]")
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    reveal();
    return activeKey ? router.subscribe("onRendered", reveal) : undefined;
  }, [router, stripRef, activeKey]);
}

function selectedTabFor(key: string): HTMLElement | null {
  const tabs = document.querySelectorAll<HTMLElement>(
    `[data-main-tab="${CSS.escape(key)}"][aria-selected="true"]`,
  );
  return [...tabs].find((tab) => tab.checkVisibility()) ?? null;
}

/**
 * Arrow keys, Home and End move focus along the strip's tabs and main's other item; Enter or Space
 * opens the focused one. Control+Tab is the browser's, so the page never sees it.
 */
function moveAlongStrip(event: KeyboardEvent<HTMLDivElement>) {
  const stops = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "[data-main-current] > button, [role=tab]",
    ),
  ];
  const at = stops.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const to =
    event.key === "ArrowRight"
      ? at + 1
      : event.key === "ArrowLeft"
        ? at - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? stops.length - 1
            : null;
  if (to === null) return;
  event.preventDefault();
  const next = stops[Math.max(0, Math.min(stops.length - 1, to))];
  next?.focus({ preventScroll: true });
  // The chip, not its overlay button, carries the scroll margin that clears the edge fade.
  next?.parentElement?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

function scrollStripWithWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const linePx = event.deltaMode === event.nativeEvent.DOM_DELTA_LINE ? 16 : 1;
  event.currentTarget.scrollBy({ left: event.deltaY * linePx });
}

function TabChipFrame({
  active,
  surface = "page",
  divider,
  children,
  tabProps,
  className,
}: {
  active: boolean;
  surface?: "page" | "review";
  divider: boolean;
  children: ReactNode;
  tabProps?: HTMLAttributes<HTMLDivElement>;
  className?: string;
}) {
  return (
    <div
      {...tabProps}
      data-active-tab={active || undefined}
      className={cn(
        "group scroll-mx-6 gap-1.5",
        tabChipClass(active),
        active && surface === "review" && "[--tab-chip-surface:var(--color-review)]",
        className,
      )}
    >
      {divider ? (
        <span
          aria-hidden
          className="absolute top-1/2 left-0 h-3.5 w-px -translate-y-1/2 bg-border"
        />
      ) : null}
      {children}
    </div>
  );
}
