/** A small, replaceable notice card shared by project surfaces. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export type SurfaceNoticeModel = {
  message: ReactNode;
  undo: (() => void) | null;
  dismiss: () => void;
  failure?: ReactNode;
  undoing?: boolean;
};

export function SurfaceNotice({
  notice,
  className,
}: {
  notice: SurfaceNoticeModel | null;
  className?: string;
}) {
  if (!notice) return null;
  return (
    <div className={cn("min-w-0", className)}>
      <div
        role="status"
        className="flex min-h-10 min-w-0 items-center gap-3 rounded-md border border-border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-sm"
      >
        <span className="min-w-0 flex-1 truncate">{notice.message}</span>
        {notice.undo ? (
          <button
            type="button"
            className="text-button shrink-0 text-sm"
            disabled={notice.undoing}
            onClick={notice.undo}
          >
            {notice.undoing ? <Trans>Restoring…</Trans> : <Trans>Undo</Trans>}
          </button>
        ) : null}
        <IconButton
          size="sm"
          className="shrink-0 [@media(pointer:coarse)]:size-11"
          aria-label={t`Dismiss`}
          onClick={notice.dismiss}
        >
          <X aria-hidden className="size-4" />
        </IconButton>
      </div>
      {notice.failure ? (
        <div role="alert" className="px-2 text-destructive text-xs">
          {notice.failure}
        </div>
      ) : null}
    </div>
  );
}
