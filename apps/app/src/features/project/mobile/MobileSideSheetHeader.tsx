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
      <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pr-1.5">{title}</div>
      {actions}
      <div
        className="flex shrink-0 items-center pl-1"
        style={{ paddingRight: "calc(0.5rem + env(safe-area-inset-right))" }}
      >
        <IconButton size="sm" onClick={onClose} label={t`Close`}>
          <X aria-hidden />
        </IconButton>
      </div>
    </header>
  );
}
