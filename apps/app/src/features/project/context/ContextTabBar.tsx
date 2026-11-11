/** ContextTabBar — the tab strip above the context main pane. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  Code2,
  File,
  FilePlus,
  FileText,
  FileType2,
  History,
  Image as ImageIcon,
  Plus,
  X,
} from "lucide-react";
import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  type WheelEvent,
} from "react";
import type { ContextTab } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReviewCopy } from "@/features/draft-review/copy-view";
import { cn } from "@/lib/utils";

import { tabChipClass } from "../shell/tab-chip";
import { fileKindIcon } from "./context-file-icon";
import type { OptimisticContextTab } from "./context-pane-state";
import { useReferenceDrag } from "./entry-drag/reference-source";
import { RemovedNoticeSlot } from "./RemovedDocumentNotice";
import { tabSubject } from "./tab-subject";

export type ContextTabBarProps = {
  tabs: ContextTab[];
  activeTabId: string | null;
  activeTabInstanceId?: string;
  optimisticTab?: OptimisticContextTab | null;
  onSelect: (tab: ContextTab) => void;
  onClose: (tab: ContextTab) => void;
  onNewDocument?: () => void;
  onShowRecents?: () => void;
  /** Whether that chooser is the surface on screen, so the control reads as current. */
  recentsActive?: boolean;
  leading?: ReactNode;
  /**
   * Pinned control docked at the strip's far-right edge (e.g. the chat dock
   * expand toggle when the dock is collapsed). Same render rule as `leading`.
   */
  trailing?: ReactNode;
  /** Feedback in the strip's free end, where a closed tab's width went. */
  notice?: ReactNode;
};

export function ContextTabBar({
  tabs,
  activeTabId,
  activeTabInstanceId,
  optimisticTab,
  onSelect,
  onClose,
  onNewDocument,
  onShowRecents,
  recentsActive = false,
  leading,
  trailing,
  notice,
}: ContextTabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  useActiveTabVisibility(stripRef, optimisticTab?.id ?? activeTabInstanceId ?? activeTabId);
  return (
    <div
      role="tablist"
      aria-label={t`Open context files`}
      className="tab-band flex h-10 shrink-0 items-stretch"
    >
      {/* pr-0.5: the first chip lands on `PaneHeader`'s x past the toggle. */}
      {leading ? <div className="flex shrink-0 items-center pr-0.5">{leading}</div> : null}
      {onShowRecents ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onShowRecents}
              aria-label={t`Recently opened`}
              aria-current={recentsActive ? "page" : undefined}
              // Chip grammar, like the tabs: on the chooser this is the place the
              // page's top edge rises into, and off it the writer gets the same
              // hover pill an inactive tab wears. Not `h-full` — items-stretch
              // sizes the chip so the active margin subtracts from its height.
              // z-1: the scroller's flare room below lies over this chip's right edge.
              className={cn("focus-ring z-1 shrink-0 gap-1.5", tabChipClass(recentsActive))}
            >
              <History className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <Trans>Recently opened</Trans>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* The padding is room for the end tabs' flares, which this scroller would clip; the
          negative margins take it back, so the first tab starts where the chip before it
          ends, as a title tab does after its index door, and New tab follows the last. */}
      <div
        ref={stripRef}
        onWheel={scrollStripWithWheel}
        className="-mx-1.5 flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden px-1.5"
      >
        {tabs.map((tab, index) => {
          const isActive = (member: ContextTab) =>
            activeTabInstanceId
              ? member.tabInstanceId === activeTabInstanceId
              : member.documentId === activeTabId;
          const active = isActive(tab);
          const previous = tabs[index - 1];
          return (
            <TabChip
              key={tab.tabInstanceId ?? tab.documentId}
              tab={tab}
              active={active}
              // Divider only between two adjacent inactive tabs — the active
              // tab's canvas shape provides its own separation.
              divider={!active && previous !== undefined && !isActive(previous)}
              onSelect={() => onSelect(tab)}
              onClose={() => onClose(tab)}
            />
          );
        })}
        {optimisticTab ? <OptimisticTabChip key={optimisticTab.id} tab={optimisticTab} /> : null}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onNewDocument}
            disabled={!onNewDocument}
            title={!onNewDocument ? t`Open a Work to create an Untitled document` : undefined}
            aria-label={t`New tab`}
            className="focus-ring relative isolate grid h-full w-10 shrink-0 place-items-center text-muted-foreground before:absolute before:inset-x-1 before:inset-y-1 before:-z-10 before:rounded-md before:transition-colors hover:text-foreground hover:before:bg-ink-fill"
          >
            {/* Same divider grammar as between tabs: a line sets the New-tab
                control apart from the working set, except when the active
                tab's canvas shape already separates it. */}
            {!optimisticTab &&
            tabs.length > 0 &&
            tabs[tabs.length - 1]?.documentId !== activeTabId ? (
              <span
                aria-hidden
                className="absolute top-1/2 left-0 h-3.5 w-px -translate-y-1/2 bg-border"
              />
            ) : null}
            <Plus className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Trans>New tab</Trans>
        </TooltipContent>
      </Tooltip>
      {/* The strip's free end: tabs keep their width until a notice needs its
          short sentence, then they scroll. */}
      <RemovedNoticeSlot>{notice}</RemovedNoticeSlot>
      {trailing ? <div className="flex shrink-0 items-center px-2">{trailing}</div> : null}
    </div>
  );
}

function OptimisticTabChip({ tab }: { tab: OptimisticContextTab }) {
  // Same name + kind glyph the settled tab will render — the chip should be
  // indistinguishable from the tab it becomes, minus interactivity.
  const Icon = fileKindIcon(tab.name);
  return (
    <TabChipFrame
      active
      divider={false}
      tabProps={{
        role: "tab",
        tabIndex: -1,
        "aria-selected": true,
        "aria-label": t`Loading ${tab.name}`,
      }}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left text-xs">
        {tab.name}
      </span>
    </TabChipFrame>
  );
}

const NOT_REVIEWING = { reviewing: false, view: null } as const;

function TabChip({
  tab,
  active,
  divider,
  onSelect,
  onClose,
}: {
  tab: ContextTab;
  active: boolean;
  divider: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  // The review is in the active tab; another tab of the same document shows it live.
  const review = useReviewCopy(tab.documentId);
  const reviewing = active && review.reviewing;
  const drag = useReferenceDrag(tabSubject(tab, reviewing ? review : NOT_REVIEWING));
  return (
    <TabChipFrame active={active} reviewing={reviewing} divider={divider} tabProps={drag}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={tab.name}
        onClick={onSelect}
        // Overlay: the entire chip is the tab's hit target. The transparent
        // button covers the chip; the close button is positioned after it so
        // it paints (and clicks) on top. The overlay carries the accessible
        // name; the visible glyph/label siblings are hidden from AT so the
        // strip doesn't announce each filename twice.
        className="focus-ring absolute inset-0"
        title={tab.kind === "new" ? tab.name : tab.path}
      />
      <FileKindIcon tab={tab} />
      <span aria-hidden className="min-w-0 flex-1 truncate text-left text-xs">
        {tab.name}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t`Close ${tab.name}`}
        className={cn(
          "focus-ring relative grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground transition-opacity",
          // Works on both fields: the active tab's canvas and the recessed strip.
          "hover:bg-ink-fill hover:text-foreground",
          // Hide on inactive tabs unless hovered, like VS Code / Cursor.
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" aria-hidden />
      </button>
    </TabChipFrame>
  );
}

/**
 * Keeps the active chip inside the strip's viewport. The router's scroll restoration also
 * records this scroller and writes a stale offset back after each navigation, so the reveal
 * runs again once the router has rendered.
 */
function useActiveTabVisibility(
  stripRef: RefObject<HTMLDivElement | null>,
  activeKey: string | null | undefined,
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

/** A plain mouse wheel only scrolls vertically; the strip turns that into its own scroll. */
function scrollStripWithWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const linePx = event.deltaMode === event.nativeEvent.DOM_DELTA_LINE ? 16 : 1;
  event.currentTarget.scrollBy({ left: event.deltaY * linePx });
}

function TabChipFrame({
  active,
  reviewing = false,
  divider,
  children,
  tabProps,
}: {
  active: boolean;
  reviewing?: boolean;
  divider: boolean;
  children: ReactNode;
  tabProps?: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div
      {...tabProps}
      data-active-tab={active || undefined}
      className={cn(
        // No h-full: items-stretch sizes the chip so the active tab's mt-1
        // subtracts from its height instead of overflowing the strip.
        // scroll-mx: scrolled into view, the active tab keeps room for its flares,
        // which the strip's scroller would clip at its edge.
        "group w-40 shrink-0 scroll-mx-1.5 gap-1.5",
        tabChipClass(active),
        // Under review the chip surfaces the review strip's tone so tab and
        // banner read as one continuous surface.
        reviewing && "[--tab-chip-surface:var(--color-review)]",
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

// One muted ink for every file-kind icon: the shape carries the kind, and the
// semantic colors stay reserved (jade = action, streaming = live, destructive
// = error) — a file's type is metadata, never a state.
function fileKindGlyph(tab: ContextTab) {
  if (tab.kind === "new") return FilePlus;
  if (tab.kind === "tracked") return tab.schemaType === "code" ? Code2 : FileText;
  if (tab.fileType === "image") return ImageIcon;
  if (tab.fileType === "pdf") return FileType2;
  return File;
}

function FileKindIcon({ tab }: { tab: ContextTab }) {
  const Icon = fileKindGlyph(tab);
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}
