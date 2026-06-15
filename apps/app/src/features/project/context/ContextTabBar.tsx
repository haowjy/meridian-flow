/**
 * ContextTabBar — the tab strip above the context main pane.
 *
 * Renders the open context-tab working set and delegates selection / close to
 * the parent controller. The active tab id is route-derived, not store-owned.
 * One affordance per tab: a file-kind glyph + the leaf name + a hover-revealed
 * close button. Active tab gets the production "selected" treatment used
 * elsewhere in the project (subtle primary tint, full-foreground text).
 *
 * Layout is three zones — pinned `leading` on the left, scrollable tabs in
 * the middle, pinned `trailing` on the right — so the project's
 * sidebar/dock expand toggles live in the strip itself (no separate header
 * band above) and stay reachable while the tabs scroll between them.
 *
 * The strip paints no background — the center slot's `bg-background` shows
 * through so the rail corner notches meet canvas, not a third tint (see
 * project `.context/CONTEXT.md` seam invariant). Per-tab chips carry
 * their own selected/hover fills.
 *
 * Pin and drag-to-reorder are deferred — the store exposes `reorderTabs`
 * as the primitive both will compose with.
 */
import { t } from "@lingui/core/macro";
import { Code2, File, FileType2, Image as ImageIcon, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ContextTab } from "@/client/stores";
import { cn } from "@/lib/utils";

export type ContextTabBarProps = {
  tabs: ContextTab[];
  activeTabId: string | null;
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
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
  leading,
  trailing,
}: ContextTabBarProps) {
  if (tabs.length === 0 && !leading && !trailing) return null;
  return (
    <div
      role="tablist"
      aria-label={t`Open context files`}
      className="flex h-10 shrink-0 items-stretch border-b border-border-subtle"
    >
      {leading ? <div className="flex shrink-0 items-center px-2">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.documentId === activeTabId;
          return (
            <TabChip
              key={tab.documentId}
              tab={tab}
              active={active}
              onSelect={() => onSelect(tab.documentId)}
              onClose={() => onClose(tab.documentId)}
            />
          );
        })}
      </div>
      {trailing ? <div className="flex shrink-0 items-center px-2">{trailing}</div> : null}
    </div>
  );
}

function TabChip({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: ContextTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex h-full max-w-[220px] shrink-0 items-center gap-1.5 border-r border-border px-3 transition-colors",
        active
          ? "bg-surface-subtle text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        // Make the chip's whole row activatable, with the X button on top.
        className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs"
        title={tab.path}
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
          "hover:bg-sidebar-accent hover:text-foreground",
          // Hide on inactive tabs unless hovered, like VS Code / Cursor.
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" aria-hidden />
      </button>
      {active ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 bg-primary"
        />
      ) : null}
    </div>
  );
}

function FileKindIcon({ tab }: { tab: ContextTab }) {
  if (tab.editable) {
    return <Code2 aria-hidden className="size-3.5 shrink-0 text-primary/80" />;
  }
  if (tab.fileType === "image") {
    return <ImageIcon aria-hidden className="size-3.5 shrink-0 text-status-streaming" />;
  }
  if (tab.fileType === "pdf") {
    return <FileType2 aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  }
  return <File aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}
