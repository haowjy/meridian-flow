/**
 * MobileChatSheetHeader — the phone chat sheet's own dock header.
 *
 * Built from the same status-bar-aware chrome primitives as `MobileTopBar`
 * (`PhoneIconButton`, safe-area padding), independent of the desktop
 * `DockHeader`. `ChatSurface` passes this as `DockShell`'s header slot for the
 * phone chat sheet; `DockHeader` itself stays desktop-only.
 */
import { t } from "@lingui/core/macro";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";

import { type DockHeaderSlotArgs, DockViewSwitch } from "../dock/DockHeader";

export type MobileChatSheetHeaderProps = DockHeaderSlotArgs & {
  onClose?: () => void;
  threadSelect?: ReactNode;
};

export function MobileChatSheetHeader({
  view,
  views,
  onSelectView,
  onClose,
  threadSelect,
}: MobileChatSheetHeaderProps) {
  return (
    <header
      className="mobile-top-bar flex h-14 shrink-0 items-stretch border-b border-border-subtle"
      style={{
        boxSizing: "content-box",
        paddingLeft: "calc(0.75rem + env(safe-area-inset-left))",
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-1.5">
        {view === "chat" ? threadSelect : null}
      </div>
      <DockViewSwitch view={view} views={views} onSelectView={onSelectView} />
      {onClose ? (
        <div
          className="flex shrink-0 items-center pl-1"
          style={{ paddingRight: "calc(0.5rem + env(safe-area-inset-right))" }}
        >
          <PhoneIconButton onClick={onClose} aria-label={t`Close chat`}>
            <X className="size-5" aria-hidden />
          </PhoneIconButton>
        </div>
      ) : null}
    </header>
  );
}
