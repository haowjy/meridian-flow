/**
 * DockHeader — the desktop dock's single header row.
 *
 * The header is part of the dock's ONE uniform chrome surface — it paints
 * nothing of its own (the dock slot owns the material) and carries no bottom
 * border. Layout: `[left slot] … [segmented view switch] [close]`. The left
 * slot hosts the chat select/rename dropdown while Chat is active; the view
 * switch carries the view identity, so there is no separate section title. The
 * switch disappears when only one view is available because a single segment
 * cannot select anything. The left slot truncates before the switch or close
 * ever compress.
 *
 * Desktop-only: the phone chat sheet supplies its own header
 * (`mobile/MobileChatSheetHeader.tsx`), built from `MobileTopBar`'s
 * status-bar-aware chrome instead of branching this one. `DockShell` takes
 * either as a header slot.
 *
 * Replaces the per-occupant RailHeader chrome in the dock: same `h-10` shell
 * and the canonical `PanelToggleButton` close, so the collapse control still
 * lands on the shared toggle column.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PanelRightClose, X } from "lucide-react";
import type { ReactNode } from "react";
import type { ContextTab } from "@/client/stores";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import type { DockView } from "./dock-view-store";

export type DockHeaderSlotArgs = {
  view: DockView;
  views: readonly DockView[];
  onSelectView: (view: DockView) => void;
  fileTab?: Extract<ContextTab, { kind: "viewer" }> | null;
  onCloseFile?: () => void;
};

export type DockHeaderProps = DockHeaderSlotArgs & {
  onClose?: () => void;
  threadSelect?: ReactNode;
  threadId?: string | null;
};

export function DockHeader({
  view,
  views,
  onSelectView,
  onClose,
  threadSelect,
  threadId,
  fileTab,
  onCloseFile,
}: DockHeaderProps) {
  const activity = useThreadActivity({
    threadId: threadId ?? "",
    rootThreadId: threadId ?? "",
    seed: null,
  });
  return (
    <header className="flex h-10 shrink-0 items-stretch pl-2">
      {/* No overflow-hidden: truncation is owned by the min-w-0/truncate chain
          inside, and clipping here shears the trigger's hover pill (it
          bleeds left of the slot). */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-1.5">
        {view === "chat" ? threadSelect : null}
        {view === "chat" && threadId ? (
          <SubagentHeader threadId={threadId} nodes={activity.activity.descendants} />
        ) : null}
      </div>
      <DockViewSwitch
        view={view}
        views={views}
        onSelectView={onSelectView}
        fileTab={fileTab}
        onCloseFile={onCloseFile}
      />
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

/** The segmented view switch, shared by the desktop header and the phone chat sheet header. */
export function DockViewSwitch({
  view,
  views,
  onSelectView,
  fileTab,
  onCloseFile,
}: DockHeaderSlotArgs) {
  if (views.length <= 1) return null;
  return (
    <SegmentedTabs
      label={t`Dock view`}
      value={view}
      onChange={onSelectView}
      options={views.map((segment) => ({
        value: segment,
        label:
          segment === "file" && fileTab ? (
            <span className="block max-w-36 truncate">{fileTab.name}</span>
          ) : (
            <DockViewLabel view={segment} />
          ),
        trailingAction:
          segment === "file" && fileTab && onCloseFile ? (
            <button
              type="button"
              aria-label={t`Close ${fileTab.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseFile();
              }}
              className="focus-ring mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground [@media(pointer:coarse)]:size-8"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null,
      }))}
    />
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
    case "file":
      return null;
  }
}
