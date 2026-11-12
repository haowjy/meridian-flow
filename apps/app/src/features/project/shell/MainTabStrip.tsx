/**
 * MainTabStrip — main's open items as folder tabs in main's band (`client/project-shell/main-tabs`).
 * The tab main shows is the active chip, joined to the page below it. Main's item when the record
 * holds no tab for it (an address that names nothing, a document back within one history entry) is
 * drawn after the tabs as the active chip, so what main shows never depends on the record.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, type LucideIcon, Plus, X } from "lucide-react";
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
  mainTabKey,
  readMainTabs,
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
import { IconButton } from "@/components/ui/icon-button";
import { draftCopyView } from "@/features/draft-review/copy-view";
import { useScrollEdges } from "@/hooks/use-scroll-edges";
import { holdFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { useAccountId } from "../context/account-feature-context";
import { useReferenceDrag } from "../context/entry-drag/reference-source";
import { tabSubject } from "../context/tab-subject";
import { useIsDraftOnly } from "../context/use-is-draft-only";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { useDocumentPaint } from "../views";
import { tabChipClass } from "./tab-chip";

/** Selecting and closing main's tabs: each writes the address from the tab it names. */
export function useMainTabCommands({
  projectId,
  open,
  mainKey,
  onShowRecents,
}: {
  projectId: string;
  open: OpenContextRoute;
  /** The tab main shows; null while main holds no tab. */
  mainKey: string | null;
  onShowRecents: (options: { replace: boolean }) => Promise<void>;
}) {
  const accountId = useAccountId();
  const openInMain = useOpenInMain(projectId, open);
  const show = useCallback(
    (tab: MainTab | null) => {
      if (tab) openInMain(tab.document, { replace: true });
      else onShowRecents({ replace: true });
    },
    [openInMain, onShowRecents],
  );
  return {
    select: (document: OpenDocument) => openInMain(document),
    close: (tab: MainTab) => {
      const key = mainTabKey(tab);
      const next = closeMainTab(accountId, projectId, key, mainKey);
      if (key === mainKey) show(next);
    },
    /** Main goes to Recently opened unless it keeps its item (a chat, or the landing itself). */
    closeAll: async ({ keepMain }: { keepMain: boolean }) => {
      // Main leaves first: while it still shows a document, that document's arrival puts its tab
      // back (`ProjectView`). An Untitled page leaves later than a filed one.
      if (!keepMain) await onShowRecents({ replace: true });
      closeAllMainTabs(accountId, projectId);
    },
    /** Main's item holds no tab: main goes to the tab it showed last, else Recently opened. */
    closeMain: () => {
      const { tabs, selected } = readMainTabs(accountId, projectId);
      show(tabs.find((tab) => mainTabKey(tab) === selected) ?? tabs.at(-1) ?? null);
    },
  };
}

export function MainTabStrip({
  projectId,
  open,
  mainKey,
  mainDocument,
  current,
  onShowRecents,
  onNewDocument,
}: {
  projectId: string;
  open: OpenContextRoute;
  mainKey: string | null;
  /** The document main shows, drawn as the active chip after the tabs when the record lacks it. */
  mainDocument?: OpenDocument;
  /** Main's item when it is not a document, drawn as the active chip after the tabs. */
  current?: ReactNode;
  onShowRecents: (options: { replace: boolean }) => Promise<void>;
  /** Absent while no Work is ready to hold an Untitled document. */
  onNewDocument?: () => void;
}) {
  const { tabs, unrecorded } = useDrawnTabs(projectId, mainKey, mainDocument);
  const commands = useMainTabCommands({ projectId, open, mainKey, onShowRecents });
  const stripRef = useRef<HTMLDivElement>(null);
  const more = useScrollEdges(stripRef);
  useActiveTabVisibility(stripRef, mainKey ?? (current ? "current" : null));
  const lastActive =
    unrecorded !== undefined || (tabs.at(-1) && mainTabKey(tabs.at(-1) as MainTab) === mainKey);
  return (
    <div
      role="tablist"
      aria-label={t`Open documents`}
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
          return (
            <DocumentTabChip
              key={mainTabKey(tab)}
              projectId={projectId}
              document={tab.document}
              active={active}
              // A divider only between two inactive tabs: the active tab's shape separates itself.
              divider={!active && previous !== undefined && mainTabKey(previous) !== mainKey}
              onSelect={(document) => commands.select(document)}
              onClose={() => commands.close(tab)}
            />
          );
        })}
        {unrecorded ? (
          <DocumentTabChip
            key={mainKey}
            projectId={projectId}
            document={unrecorded}
            active
            divider={false}
            onSelect={(document) => commands.select(document)}
            onClose={() => commands.close({ kind: "document", document: unrecorded })}
          />
        ) : null}
        {current ? (
          // The active item never shrinks: the inactive tabs give way first, then the strip scrolls.
          <div
            data-active-tab
            data-main-current
            className="flex max-w-60 shrink-0 scroll-mx-6 items-stretch"
          >
            {current}
          </div>
        ) : null}
      </div>
      {/* New document follows document tabs only: after main's other item (a chat) it would read
          as a new one of those. */}
      {current ? null : (
        <IconButton
          size="sm"
          label={t`New document`}
          // aria-disabled, not disabled: the tooltip has to say why it can't run.
          tooltip={onNewDocument ? undefined : t`Open a Work to create an Untitled document`}
          aria-disabled={!onNewDocument || undefined}
          onClick={onNewDocument}
          tooltipSide="bottom"
          className="relative self-center aria-disabled:opacity-50"
        >
          {tabs.length > 0 && !lastActive ? (
            <span
              aria-hidden
              className="absolute top-1/2 -left-1 h-3.5 w-px -translate-y-1/2 bg-border"
            />
          ) : null}
          <Plus aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

/** Every tab of the strip in one list, to jump to one the strip has squeezed or scrolled away. */
export function MainTabMenu({
  projectId,
  open,
  mainKey,
  mainDocument,
  keepMain,
  onShowRecents,
}: {
  projectId: string;
  open: OpenContextRoute;
  mainKey: string | null;
  mainDocument?: OpenDocument;
  /** Close all leaves main's item where it is: a chat is not a tab, and the landing is the goal. */
  keepMain: boolean;
  onShowRecents: (options: { replace: boolean }) => Promise<void>;
}) {
  const { tabs, unrecorded } = useDrawnTabs(projectId, mainKey, mainDocument);
  const commands = useMainTabCommands({ projectId, open, mainKey, onShowRecents });
  // Each document's page has its own band, so the trigger Radix would refocus is gone.
  const focusAfter = useRef<(() => HTMLElement | null) | null>(null);
  const documents = tabs.map((tab) => tab.document);
  if (unrecorded) documents.push(unrecorded);
  if (documents.length === 0) return null;
  const label = t`All open documents`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="sm"
          label={label}
          tooltipSide="bottom"
          className="mr-1 ml-auto self-center"
        >
          <ChevronDown aria-hidden />
        </IconButton>
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
        {documents.map((document) => (
          <TabMenuItem
            key={document.documentId}
            document={document}
            active={mainTabKey({ kind: "document", document }) === mainKey}
            onSelect={(picked) => {
              focusAfter.current = () => selectedTabFor(picked.documentId);
              commands.select(picked);
            }}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabMenuItem({
  document,
  active,
  onSelect,
}: {
  document: OpenDocument;
  active: boolean;
  onSelect: (document: OpenDocument) => void;
}) {
  return (
    <DropdownMenuItem
      selected={active}
      onSelect={() => onSelect(document)}
      title={document.kind === "new" ? document.name : document.path}
    >
      <span className="min-w-0 truncate">{document.name}</span>
    </DropdownMenuItem>
  );
}

/** The document tabs the strip draws: the live record, then main's document when it lacks it. */
function useDrawnTabs(projectId: string, mainKey: string | null, mainDocument?: OpenDocument) {
  const { tabs, project } = useLiveTabs(projectId);
  const unrecorded =
    mainDocument && mainKey && !tabs.some((tab) => mainTabKey(tab) === mainKey)
      ? project(mainDocument)
      : undefined;
  return { tabs, unrecorded };
}

function DocumentTabChip({
  projectId,
  document,
  active,
  divider,
  onSelect,
  onClose,
}: {
  projectId: string;
  document: OpenDocument;
  active: boolean;
  divider: boolean;
  onSelect: (document: OpenDocument) => void;
  onClose: () => void;
}) {
  // The active tab names what main paints: its draft while main reviews one.
  const paint = useDocumentPaint(projectId, active ? document : null);
  const drafts = useOwnerDrafts(projectId, paint.draft?.ownerKey ?? null);
  const file = paint.draft ? drafts.fileForDocument(document.documentId) : null;
  const reviewing = active && paint.showing === "draft";
  const isDraftOnly = useIsDraftOnly(projectId);
  const drag = useReferenceDrag(
    tabSubject(
      document,
      {
        reviewing,
        view: file && paint.draft ? draftCopyView(file, paint.draft.ownerKey) : null,
      },
      isDraftOnly(document.documentId),
    ),
  );
  const heldWidth = useHeldTabWidth();
  const closeByPointer = (chip: HTMLElement | null) => {
    holdTabWidth(chip);
    onClose();
  };
  return (
    <TabChipFrame
      active={active}
      reviewing={reviewing}
      divider={divider}
      tabProps={{
        ...drag,
        style: heldWidth === null ? undefined : { flex: `0 0 ${heldWidth}px` },
        // Anywhere on the tab, its close included, as in Chrome.
        onAuxClick: (event) => {
          if (event.button === 1) closeByPointer(event.currentTarget);
        },
      }}
      // Every tab is one width, as in Chrome: 240px, all shrinking together when the band is full,
      // to the start of its name (a chapter's number). No icon: every document's would be the same.
      // The open tab keeps room for its close; the strip scrolls past that.
      className={cn("@container/tab w-60 shrink", active ? "min-w-16" : "min-w-12")}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={document.name}
        // One stop in the Tab order; the arrows move along the strip (`moveAlongStrip`).
        tabIndex={active ? 0 : -1}
        data-main-tab={document.documentId}
        onClick={(event) => {
          const focused = event.currentTarget === window.document.activeElement;
          onSelect(document);
          // Each document's page has its own band: the focus follows to this tab in the new one.
          if (focused) holdFocus(() => selectedTabFor(document.documentId));
        }}
        // The whole chip is the hit target; the close button sits above it. The overlay carries
        // the name, so the visible label is hidden from assistive tech.
        className="focus-ring absolute inset-0"
        title={document.kind === "new" ? document.name : document.path}
      />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left text-xs">
        {document.name}
      </span>
      <TabCloseButton
        name={document.name}
        active={active}
        onClose={(event) =>
          event.detail > 0 ? closeByPointer(event.currentTarget.parentElement) : onClose()
        }
      />
    </TabChipFrame>
  );
}

/**
 * Main's item when it takes no tab (an address that names nothing, a document in Trash): a chip
 * in the strip that says what main shows, and closing it leaves the address.
 */
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
        // On every tab, in the same place, so closing several is one target after another; an
        // inactive tab narrower than 64px (40px inside its padding) gives the close up, as in Chrome.
        !active && "@max-[2.5rem]/tab:hidden",
      )}
    >
      <X className="size-3" aria-hidden />
    </button>
  );
}

/**
 * While the writer closes tabs with the pointer, the tabs keep the width they had, so the next
 * close lands under the pointer (Chrome's rule); they resize once the pointer leaves the strip.
 * One value per window, outside the strip: each document has its own band, so closing main's tab
 * draws a new strip.
 */
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
  // An inactive tab's width: at the minimum the open tab is wider (it keeps room for its close),
  // and holding that would widen every tab under the pointer.
  const inactive = chip
    .closest("[data-main-tab-strip]")
    ?.querySelector('[role=tab][aria-selected="false"]')?.parentElement;
  setHeldTabWidth((inactive ?? chip).getBoundingClientRect().width);
  if (!first) return;
  // Released when the pointer crosses out of the strip, presses anywhere else (a touch tap fires
  // no move), or a mouse leaves the window from it; a touch lift also reports leaving to nowhere.
  // Closing main's tab redraws the strip, and for a frame the pointer is over the band behind it:
  // that crossing comes from outside the strip, so it doesn't count.
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

function selectedTabFor(documentId: string): HTMLElement | null {
  const tabs = document.querySelectorAll<HTMLElement>(
    `[data-main-tab="${CSS.escape(documentId)}"][aria-selected="true"]`,
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

/** A plain mouse wheel only scrolls vertically; the strip turns that into its own scroll. */
function scrollStripWithWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const linePx = event.deltaMode === event.nativeEvent.DOM_DELTA_LINE ? 16 : 1;
  event.currentTarget.scrollBy({ left: event.deltaY * linePx });
}

export function TabChipFrame({
  active,
  reviewing = false,
  divider,
  children,
  tabProps,
  className,
}: {
  active: boolean;
  reviewing?: boolean;
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
        // No h-full: items-stretch sizes the chip so the active tab's top margin subtracts from
        // its height. scroll-mx: scrolled into view, the active tab keeps room for its flares.
        "group scroll-mx-6 gap-1.5",
        tabChipClass(active),
        // Under review the chip takes the review strip's tone, so tab and band read as one.
        reviewing && "[--tab-chip-surface:var(--color-review)]",
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
