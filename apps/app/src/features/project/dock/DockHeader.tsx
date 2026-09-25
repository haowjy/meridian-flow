/**
 * DockHeader — the single header row for the tabbed right dock.
 *
 * The header is part of the dock's ONE uniform chrome surface — it paints
 * nothing of its own (the dock slot owns the material) and carries no bottom
 * border. Layout: `[left slot] … [segmented view switch] [close]`. The left
 * slot hosts the chat index door and the chat select/rename dropdown while
 * Chat is active; the view switch carries the view identity, so there is no
 * separate section title. The switch disappears when only one view is
 * available because a single segment cannot select anything.
 * The left slot truncates before the switch or close ever compress.
 *
 * Replaces the per-occupant RailHeader chrome in the dock: same `h-10` shell
 * and the canonical `PanelToggleButton` close, so the collapse control still
 * lands on the shared toggle column.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PanelRightClose, X } from "lucide-react";
import type { ReactNode } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { cn } from "@/lib/utils";

import { PanelToggleButton } from "../shell/PanelToggleButton";
import type { DockView } from "./dock-view-store";

export type DockHeaderProps = {
  view: DockView;
  views: readonly DockView[];
  onSelectView: (view: DockView) => void;
  onClose?: () => void;
  threadSelect?: ReactNode;
  /** `phone` — the chat sheet: a status-bar-aware 56px row with 44px targets. */
  chrome?: "desktop" | "phone";
};

export function DockHeader({
  view,
  views,
  onSelectView,
  onClose,
  threadSelect,
  chrome = "desktop",
}: DockHeaderProps) {
  const phone = chrome === "phone";
  return (
    <header
      className={cn(
        "flex shrink-0 items-stretch",
        phone ? "mobile-top-bar h-14 border-b border-border-subtle" : "h-10 pl-2",
      )}
      style={
        phone
          ? {
              boxSizing: "content-box",
              paddingLeft: "calc(0.75rem + env(safe-area-inset-left))",
            }
          : undefined
      }
    >
      {/* No overflow-hidden: truncation is owned by the min-w-0/truncate chain
          inside, and clipping here shears the trigger's hover pill (it
          reaches 6px left of the slot for optical text alignment). */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-1.5">
        {view === "chat" ? threadSelect : null}
      </div>
      {views.length > 1 ? (
        <SegmentedTabs
          label={t`Dock view`}
          value={view}
          onChange={onSelectView}
          options={views.map((segment) => ({
            value: segment,
            label: <DockViewLabel view={segment} />,
          }))}
        />
      ) : null}
      {onClose && phone ? (
        <div
          className="flex shrink-0 items-center pl-1"
          style={{ paddingRight: "calc(0.5rem + env(safe-area-inset-right))" }}
        >
          <PhoneIconButton onClick={onClose} aria-label={t`Close chat`}>
            <X className="size-5" aria-hidden />
          </PhoneIconButton>
        </div>
      ) : onClose ? (
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
