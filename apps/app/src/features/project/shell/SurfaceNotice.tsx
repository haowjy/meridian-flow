/**
 * The notice card project surfaces show after a delete or a move, and the one
 * notice place each surface has. A surface shows one notice: a newer one, of
 * either kind, replaces the older (`useNoticeSlot`).
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export type NoticeSurface = "sidebar" | "work-files" | "mobile" | "chat-files";

type NoticeSlots = {
  /** Claims a surface's notice place; `release` closes whatever held it before. */
  take: (surface: NoticeSurface, release: () => void) => void;
};

const NoticeSlotsContext = createContext<NoticeSlots | null>(null);

/** One per project, around every surface that shows notices. */
export function NoticeSlotsProvider({ children }: { children: ReactNode }) {
  const holders = useRef(new Map<NoticeSurface, () => void>());
  const take = useCallback((surface: NoticeSurface, release: () => void) => {
    const previous = holders.current.get(surface);
    holders.current.set(surface, release);
    previous?.();
  }, []);
  const value = useMemo(() => ({ take }), [take]);
  return <NoticeSlotsContext.Provider value={value}>{children}</NoticeSlotsContext.Provider>;
}

export function useNoticeSlot(): NoticeSlots {
  const slots = useContext(NoticeSlotsContext);
  if (!slots) throw new Error("NoticeSlotsProvider is required");
  return slots;
}

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
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice.message}</span>
        {notice.undo ? (
          <button
            type="button"
            className="text-button shrink-0 text-sm"
            disabled={notice.undoing}
            onClick={notice.undo}
          >
            <Trans>Undo</Trans>
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
