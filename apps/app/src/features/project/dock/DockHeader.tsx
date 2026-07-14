/**
 * DockHeader — the single header row for the tabbed right dock.
 *
 * The header is the dock's tab strip: a recessed chrome band
 * (`bg-sidebar-accent`, no bottom border) speaking the same tonal grammar as
 * `ContextTabBar`. Layout: `[left slot] … [view tabs] [close]`. The left slot
 * hosts the chat select/rename dropdown while Chat is active; the tabs
 * themselves carry the view identity, so there is no separate section title.
 * The left slot truncates before the tabs or close ever compress.
 *
 * Replaces the per-occupant RailHeader chrome in the dock: same `h-10` shell
 * and the canonical `PanelToggleButton` close, so the collapse control still
 * lands on the shared toggle column.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { PanelToggleButton } from "../shell/PanelToggleButton";
import type { DockView } from "./dock-view-store";

export type DockHeaderProps = {
  view: DockView;
  views: readonly DockView[];
  onSelectView: (view: DockView) => void;
  /** Collapse the whole dock. Omitted only where the header isn't rendered. */
  onClose?: () => void;
  /**
   * The chat select/rename dropdown, supplied by the chat occupant. Rendered
   * in the left slot only while the Chat view is active.
   */
  threadSelect?: ReactNode;
};

export function DockHeader({ view, views, onSelectView, onClose, threadSelect }: DockHeaderProps) {
  return (
    <header className="flex h-10 shrink-0 items-stretch bg-sidebar-accent pl-2">
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {view === "chat" ? threadSelect : null}
      </div>
      <DockViewSwitch views={views} view={view} onSelectView={onSelectView} />
      {onClose ? (
        <div className="flex shrink-0 items-center px-1.5">
          <PanelToggleButton icon={PanelRightClose} label={t`Collapse dock`} onClick={onClose} />
        </div>
      ) : null}
    </header>
  );
}

/**
 * DockViewSwitch — static tabs in the tab strip's exact grammar, mode-switch
 * scale: the active view is a chip surfacing the dock's own field tone
 * (`bg-sidebar`, rounded top, Obsidian-style bottom flares) out of the
 * recessed header band; inactive views get the inset hover pill. Selection is
 * the tonal step, never an outline. The set is fixed — tabs never close or
 * grow — so no dividers or `+`; with one tab always active, the doc strip's
 * inactive-neighbor divider rule never fires anyway. No count or badge on any
 * segment — the composer DraftDock strip carries discovery.
 */
function DockViewSwitch({
  views,
  view,
  onSelectView,
}: {
  views: readonly DockView[];
  view: DockView;
  onSelectView: (view: DockView) => void;
}) {
  return (
    <div role="tablist" aria-label={t`Dock view`} className="flex shrink-0 items-stretch">
      {views.map((segment) => {
        const active = segment === view;
        return (
          <button
            key={segment}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelectView(segment)}
            // No transition on the chip: activation swaps geometry instantly,
            // so a background fade would flash the outgoing chip as a full
            // rectangle — same rule as ContextTabBar. Only the hover pill
            // transitions.
            className={cn(
              "focus-ring relative shrink-0 px-3 text-xs",
              active
                ? cn(
                    "mt-1 rounded-t-md bg-sidebar text-foreground",
                    "before:pointer-events-none before:absolute before:bottom-0 before:-left-(--radius-md) before:size-(--radius-md) before:[background:radial-gradient(circle_at_0_0,transparent_calc(var(--radius-md)-0.5px),var(--color-sidebar)_var(--radius-md))]",
                    "after:pointer-events-none after:absolute after:bottom-0 after:-right-(--radius-md) after:size-(--radius-md) after:[background:radial-gradient(circle_at_100%_0,transparent_calc(var(--radius-md)-0.5px),var(--color-sidebar)_var(--radius-md))]",
                  )
                : cn(
                    "isolate text-muted-foreground hover:text-foreground",
                    "before:absolute before:inset-x-0.5 before:inset-y-1 before:-z-10 before:rounded-md before:transition-colors hover:before:bg-sidebar/50",
                  ),
            )}
          >
            <DockViewLabel view={segment} />
          </button>
        );
      })}
    </div>
  );
}

/** The one place dock view labels are spelled. */
function DockViewLabel({ view }: { view: DockView }) {
  switch (view) {
    case "chat":
      return <Trans>Chat</Trans>;
    case "context":
      return <Trans>Context</Trans>;
    case "changes":
      return <Trans>Changes</Trans>;
  }
}
