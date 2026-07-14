/**
 * ContextTabBar — the tab strip above the context main pane.
 *
 * Renders the open context-tab working set and delegates selection / close to
 * the parent controller. The active tab id is route-derived, not store-owned.
 * One affordance per tab: a file-kind glyph + the leaf name + a hover-revealed
 * close button.
 *
 * Separation is purely tonal — no horizontal rules anywhere. The strip is a
 * recessed chrome band (`bg-sidebar-accent`, no bottom border); the active tab
 * is borderless canvas (`bg-background`, rounded top) so it reads as the page
 * continuing upward into the strip. Short vertical dividers appear only
 * between two adjacent *inactive* tabs; the active tab's shape is the only
 * selection signal. (See project `.context/CONTEXT.md` seam invariant — the
 * strip paints the chrome-step token, so chrome meets chrome at the rail
 * corner notches.)
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
import { type ReactNode, useEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ContextTabBarProps = {
  tabs: ContextTab[];
  activeTabId: string | null;
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
  onNewTemp: () => void;
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
  onSelect,
  onClose,
  onNewTemp,
  leading,
  trailing,
}: ContextTabBarProps) {
  return (
    <div
      role="tablist"
      aria-label={t`Open context files`}
      className="flex h-10 shrink-0 items-stretch bg-sidebar-accent"
    >
      {leading ? <div className="flex shrink-0 items-center px-2">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto pl-2">
        {tabs.map((tab, index) => {
          const active = tab.documentId === activeTabId;
          const previous = tabs[index - 1];
          return (
            <TabChip
              key={tab.documentId}
              tab={tab}
              active={active}
              // Divider only between two adjacent inactive tabs — the active
              // tab's canvas shape provides its own separation.
              divider={!active && previous !== undefined && previous.documentId !== activeTabId}
              onSelect={() => onSelect(tab.documentId)}
              onClose={() => onClose(tab.documentId)}
            />
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNewTemp}
              aria-label={t`New tab`}
              className="focus-ring grid h-full w-10 shrink-0 place-items-center text-muted-foreground hover:bg-background/40 hover:text-foreground"
            >
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
  const chipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the active tab visible when the strip overflows — activating a tab
    // (e.g. via the `+` button) must never land it off-screen.
    if (active) chipRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);
  return (
    <div
      ref={chipRef}
      className={cn(
        "group relative flex h-full max-w-[220px] shrink-0 items-center gap-1.5 px-3 transition-colors",
        // Active tab is borderless canvas continuing upward out of the
        // recessed strip: no hairline, no lift — selection is the tonal step,
        // nothing else.
        active
          ? "rounded-t-lg bg-background text-foreground"
          : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
      )}
    >
      {divider ? (
        <span
          aria-hidden
          className="absolute top-1/2 left-0 h-3.5 w-px -translate-y-1/2 bg-border"
        />
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        // Make the chip's whole row activatable, with the X button on top.
        className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs"
        title={tab.kind === "temp" ? tab.name : tab.path}
      >
        <FileKindIcon tab={tab} />
        <span className="min-w-0 truncate">{tab.name}</span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          // Don't double-trigger selection when closing.
          event.stopPropagation();
          onClose();
        }}
        aria-label={t`Close ${tab.name}`}
        className={cn(
          "focus-ring grid size-4 shrink-0 place-items-center rounded text-muted-foreground transition-opacity",
          // Works on both fields: the active tab's canvas and the recessed strip.
          "hover:bg-foreground/10 hover:text-foreground",
          // Hide on inactive tabs unless hovered, like VS Code / Cursor.
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

function FileKindIcon({ tab }: { tab: ContextTab }) {
  if (tab.kind === "temp")
    return <FilePlus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  if (tab.kind === "tracked") {
    const Icon = tab.schemaType === "code" ? Code2 : FileText;
    return <Icon aria-hidden className="size-3.5 shrink-0 text-primary/80" />;
  }
  if (tab.fileType === "image") {
    return <ImageIcon aria-hidden className="size-3.5 shrink-0 text-status-streaming" />;
  }
  if (tab.fileType === "pdf") {
    return <FileType2 aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  }
  return <File aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}
