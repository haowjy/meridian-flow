/**
 * DockHeader — the single header row for the tabbed right dock.
 *
 * Layout: `[left slot] … [segmented switch] [close]`. The left slot is
 * "titled": it shows the active view's identity — the chat select/rename
 * dropdown when Chat is active, a quiet section label (CONTEXT / CHANGES)
 * otherwise. The left slot truncates before the switch or close ever compress.
 *
 * Replaces the per-occupant RailHeader chrome in the dock: same `h-10`
 * border-b shell and the canonical `PanelToggleButton` close, so the collapse
 * control still lands on the shared toggle column.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";

import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

import { PaneTitle } from "../PaneTitle";
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
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2">
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {view === "chat" ? (
          (threadSelect ?? (
            <PaneTitle>
              <DockViewLabel view="chat" />
            </PaneTitle>
          ))
        ) : (
          <SectionLabel className="px-1">
            <DockViewLabel view={view} />
          </SectionLabel>
        )}
      </div>
      <DockViewSwitch views={views} view={view} onSelectView={onSelectView} />
      {onClose ? (
        <PanelToggleButton icon={PanelRightClose} label={t`Collapse dock`} onClick={onClose} />
      ) : null}
    </header>
  );
}

/**
 * DockViewSwitch — compact quiet-text segmented control. Header furniture, not
 * a toolbar: the active segment gets the production selected tint
 * (`bg-surface-subtle` + full-foreground text), the rest stay muted. No count
 * or badge on any segment — the composer DraftDock strip carries discovery.
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
      className="flex shrink-0 items-center rounded-md border border-border-subtle p-0.5"
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
              "focus-ring rounded-sm px-2 py-0.5 text-caption transition-colors",
              active
                ? "bg-surface-subtle font-medium text-foreground"
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

/** The one place dock view labels are spelled, shared by the switch and title. */
export function DockViewLabel({ view }: { view: DockView }) {
  switch (view) {
    case "chat":
      return <Trans>Chat</Trans>;
    case "context":
      return <Trans>Context</Trans>;
    case "changes":
      return <Trans>Changes</Trans>;
  }
}
