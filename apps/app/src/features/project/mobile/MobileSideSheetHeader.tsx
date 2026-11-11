/**
 * MobileSideSheetHeader — the band above the phone's side sheet: what the side shows (its picker,
 * reason and held mark), its actions, and the sheet's close.
 *
 * Built from the same status-bar-aware chrome primitives as `MobileTopBar` (`IconButton`,
 * safe-area padding), independent of the desktop `SideHeader`.
 */
import { t } from "@lingui/core/macro";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";

export function MobileSideSheetHeader({
  title,
  actions,
  onClose,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <header
      className="mobile-top-bar flex h-14 shrink-0 items-stretch border-b border-border-subtle"
      style={{
        boxSizing: "content-box",
        paddingLeft: "calc(0.75rem + env(safe-area-inset-left))",
      }}
    >
      {/* Relative: a refused chat rename floats under the header from here. */}
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pr-1.5">{title}</div>
      {actions}
      <div
        className="flex shrink-0 items-center pl-1"
        style={{ paddingRight: "calc(0.5rem + env(safe-area-inset-right))" }}
      >
        <IconButton size="sm" onClick={onClose} label={t`Close`}>
          <X className="size-5" aria-hidden />
        </IconButton>
      </div>
    </header>
  );
}
