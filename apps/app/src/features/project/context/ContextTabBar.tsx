/**
 * ContextTabBar — the tab strip above the context main pane.
 *
 * Renders the open context-tab working set and delegates selection / close to
 * the parent controller. The active tab id is route-derived, not store-owned.
 * One affordance per tab: a file-kind glyph + the leaf name + a hover-revealed
 * close button.
 *
 * Separation is purely tonal — no horizontal rules anywhere. The strip paints
 * NOTHING of its own: it sits transparent on the center cell's chrome field
 * (the same rule as `PaneHeader` and `DockHeader` — the slot paints the
 * material, bands never do). The active tab is borderless canvas
 * (`bg-background`, rounded top, Obsidian-style bottom flares) so it reads
 * as the page continuing upward into the strip. Short
 * vertical dividers appear only against an inactive neighbor — between two
 * adjacent *inactive* tabs, and before the `+` control when the last tab is
 * inactive; the active tab's shape is the only selection signal. (See project
 * `.context/CONTEXT.md` seam invariant — the band is transparent; the center
 * slot's `chrome-field` owns the paint.)
 *
 * Layout is three zones — pinned `leading` on the left, scrollable tabs in
 * the middle, pinned `trailing` on the right — so the project's
 * sidebar/dock expand toggles live in the strip itself (no separate header
 * band above) and stay reachable while the tabs scroll between them.
 *
 * Pin and drag-to-reorder are deferred — the store exposes `reorderTabs`
 * as the primitive both will compose with.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  Code2,
  File,
  FilePlus,
  FileText,
  FileType2,
  Image as ImageIcon,
  Plus,
  X,
} from "lucide-react";
import { type HTMLAttributes, type ReactNode, useEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "./context-file-icon";
import type { OptimisticContextTab } from "./context-pane-state";

export type ContextTabBarProps = {
  tabs: ContextTab[];
  activeTabId: string | null;
  /**
   * Tab whose document is under inline draft review. That chip surfaces the
   * review strip's tone (dock-surface) instead of canvas, so the tab and the
   * review banner below it read as one continuous surface.
   */
  reviewingTabId?: string | null;
  optimisticTab?: OptimisticContextTab | null;
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
  onNewDocument: () => void;
  /**
   * Pinned control docked at the strip's far-left edge (e.g. the project
   * sidebar expand toggle when the sidebar is collapsed). When present, the
   * strip renders even with zero open tabs so the control stays reachable.
   */
  leading?: ReactNode;
  /**
   * Pinned control docked at the strip's far-right edge (e.g. the chat dock
   * expand toggle when the dock is collapsed). Same render rule as `leading`.
   */
  trailing?: ReactNode;
};

export function ContextTabBar({
  tabs,
  activeTabId,
  reviewingTabId,
  optimisticTab,
  onSelect,
  onClose,
  onNewDocument,
  leading,
  trailing,
}: ContextTabBarProps) {
  return (
    <div
      role="tablist"
      aria-label={t`Open context files`}
      // Chips surface the canvas tone — see the tab-chip grammar in globals.css.
      className="flex h-10 shrink-0 items-stretch [--tab-chip-surface:var(--color-background)]"
    >
      {leading ? <div className="flex shrink-0 items-center px-2">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden pl-2">
        {tabs.map((tab, index) => {
          const active = tab.documentId === activeTabId;
          const previous = tabs[index - 1];
          return (
            <TabChip
              key={tab.documentId}
              tab={tab}
              active={active}
              reviewing={tab.documentId === reviewingTabId}
              // Divider only between two adjacent inactive tabs — the active
              // tab's canvas shape provides its own separation.
              divider={!active && previous !== undefined && previous.documentId !== activeTabId}
              onSelect={() => onSelect(tab.documentId)}
              onClose={() => onClose(tab.documentId)}
            />
          );
        })}
        {optimisticTab ? <OptimisticTabChip key={optimisticTab.id} tab={optimisticTab} /> : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNewDocument}
              aria-label={t`New tab`}
              className="focus-ring relative isolate grid h-full w-10 shrink-0 place-items-center text-muted-foreground before:absolute before:inset-x-1 before:inset-y-1 before:-z-10 before:rounded-md before:transition-colors hover:text-foreground hover:before:bg-background/50"
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
          <TooltipContent side="bottom" sideOffset={4}>
            <Trans>New tab</Trans>
          </TooltipContent>
        </Tooltip>
      </div>
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

function TabChip({
  tab,
  active,
  reviewing,
  divider,
  onSelect,
  onClose,
}: {
  tab: ContextTab;
  active: boolean;
  reviewing: boolean;
  divider: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <TabChipFrame active={active} reviewing={reviewing} divider={divider}>
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
          "focus-ring relative grid size-4 shrink-0 place-items-center rounded text-muted-foreground transition-opacity",
          // Works on both fields: the active tab's canvas and the recessed strip.
          "hover:bg-foreground/10 hover:text-foreground",
          // Hide on inactive tabs unless hovered, like VS Code / Cursor.
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" aria-hidden />
      </button>
    </TabChipFrame>
  );
}

function useActiveTabVisibility(active: boolean) {
  const chipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Selecting or optimistically restoring a tab must never leave the active
    // chip outside an overflowing strip's viewport.
    if (active) chipRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);
  return chipRef;
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
  const chipRef = useActiveTabVisibility(active);
  return (
    <div
      {...tabProps}
      ref={chipRef}
      className={cn(
        // No h-full: items-stretch sizes the chip so the active tab's mt-1
        // subtracts from its height instead of overflowing the strip.
        "group relative flex max-w-[220px] shrink-0 items-center gap-1.5 px-3",
        active
          ? "tab-chip-active text-foreground"
          : "tab-chip-inactive text-muted-foreground hover:text-foreground",
        // Under review the chip surfaces the review strip's tone so tab and
        // banner read as one continuous surface.
        reviewing && "[--tab-chip-surface:var(--color-dock-surface)]",
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
