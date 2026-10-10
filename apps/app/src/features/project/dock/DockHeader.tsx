/** The desktop dock header names its document or the screen’s native occupant. */
import { t } from "@lingui/core/macro";
import { PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";
import { SubagentHeader } from "@/features/chat/SubagentHeader";
import { useThreadActivity } from "@/features/chat/useThreadActivity";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import type { ScreenKey } from "../shell/screens";
import { DockDocumentClose, DockOpenInEditor } from "./DockDocumentButtons";
import { DockDocumentTitle, DockTitleMenu } from "./DockDocumentTitle";
import type { DockDocument } from "./dock-document-store";

export type DockHeaderSlotArgs = {
  screen: ScreenKey;
  projectId: string;
  /** The document that replaces the views while the dock shows one. */
  document: DockDocument | null;
};

export type DockHeaderProps = DockHeaderSlotArgs & {
  onClose?: () => void;
  threadSelect?: ReactNode;
  threadId?: string | null;
};

export function DockHeader({
  projectId,
  screen,
  document: dockDocument,
  onClose,
  threadSelect,
  threadId,
}: DockHeaderProps) {
  const activity = useThreadActivity({
    threadId: threadId ?? "",
    seed: null,
  });
  return (
    <header className="flex h-10 shrink-0 items-stretch pl-2">
      {/* No overflow-hidden: truncation is owned by the min-w-0/truncate chain
          inside, and clipping here shears the trigger's hover pill (it
          bleeds left of the slot). */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pr-1.5">
        {dockDocument ? (
          <>
            <DockDocumentClose />
            <DockDocumentTitle projectId={projectId} document={dockDocument} />
          </>
        ) : (
          <>
            {/* The Chat screen's rail: the same chip as an open document's, with nothing open. */}
            {screen === "chat" ? <DockTitleMenu projectId={projectId} tab={null} /> : null}
            {screen !== "chat" ? threadSelect : null}
            {screen !== "chat" && threadId ? (
              <SubagentHeader threadId={threadId} nodes={activity.activity.children} />
            ) : null}
          </>
        )}
      </div>
      {onClose || dockDocument ? (
        // px-2 matches ContextTabBar's trailing zone so the collapse toggle
        // sits exactly where the expand toggle appears when the dock closes —
        // collapse/expand must round-trip without moving the mouse.
        <div className="flex shrink-0 items-center gap-0.5 px-2">
          {dockDocument ? <DockOpenInEditor projectId={projectId} document={dockDocument} /> : null}
          {onClose ? (
            <PanelToggleButton icon={PanelRightClose} label={t`Collapse dock`} onClick={onClose} />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
