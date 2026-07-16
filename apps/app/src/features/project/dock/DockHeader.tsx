/**
 * DockHeader — the single header row for the tabbed right dock.
 *
 * The header is part of the dock's ONE uniform chrome surface — it paints
 * nothing of its own (the dock slot owns the material) and carries no bottom
 * border. Layout: `[left slot] … [view pills] [close]`. The left slot hosts
 * the chat select/rename dropdown while Chat is active; the view pills carry
 * the view identity, so there is no separate section title. The left slot
 * truncates before the pills or close ever compress.
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
    <header className="flex h-10 shrink-0 items-stretch pl-2">
      {/* No overflow-hidden: truncation is owned by the min-w-0/truncate chain
          inside, and clipping here shears the trigger's hover pill (it
          reaches 6px left of the slot for optical text alignment). */}
      <div className="flex min-w-0 flex-1 items-center pr-1.5">
        {view === "chat" ? threadSelect : null}
      </div>
      <DockViewSwitch views={views} view={view} onSelectView={onSelectView} />
      {onClose ? (
        // px-2 matches ContextTabBar's trailing zone so the collapse toggle
        // sits exactly where the expand toggle appears when the dock closes —
        // collapse/expand must round-trip without moving the mouse.
        <div className="flex shrink-0 items-center px-2">
          <PanelToggleButton icon={PanelRightClose} label={t`Collapse dock`} onClick={onClose} />
        </div>
      ) : null}
    </header>
  );
}

/**
 * DockViewSwitch — a contained segmented switch, deliberately NOT tabs: the
 * dock is one uniform chrome surface and nothing "rises" out of it (only the
 * page does that, via the document tab strip). The recessed track gives the
 * control a complete boundary — a bare pressed pill floating at the window's
 * top corner read as a tab with its base cut off. The active segment surfaces
 * the paper tone inside the track; selection is tonal, never an outline. The
 * set is fixed — views never close or grow. No count or badge on any segment —
 * the composer DraftDock strip carries discovery.
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
    <div
      role="tablist"
      aria-label={t`Dock view`}
      className="flex shrink-0 items-center self-center rounded-lg bg-foreground/6 p-0.5"
    >
      {views.map((segment) => {
        const active = segment === view;
        return (
          <button
            key={segment}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelectView(segment)}
            className={cn(
              "focus-ring h-6 shrink-0 rounded-[calc(var(--radius-lg)-2px)] px-2.5 text-xs transition-colors",
              active
                ? "bg-background font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
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
