/**
 * The notice card project surfaces show after a delete, a move or a copy, and
 * where it goes. A notice has one place: on a phone, each surface's own (inline,
 * at the foot of its list); on desktop, one shared place in the Activity corner
 * at the window's bottom-right. A place shows one Undo notice: a newer one, of
 * either kind and from any surface sharing the place, replaces the older
 * (`useNoticeSlot`). `NoticePlacement` puts a card in its place: inline, or as
 * its own entry in the toast registry, which orders and folds it with the
 * other toasts (`project-notices.tsx` turns the corner on).
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useToastSlot } from "@/components/app/toast-registry";
import { IconButton } from "@/components/ui/icon-button";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";

export const NOTICE_SURFACES = ["sidebar", "work-files", "mobile", "chat-files"] as const;
export type NoticeSurface = (typeof NOTICE_SURFACES)[number];

/** For a surface name that was stored and read back. */
export const isNoticeSurface = (value: unknown): value is NoticeSurface =>
  NOTICE_SURFACES.some((surface) => surface === value);

type NoticeSlots = {
  /** Claims the notice place `surface` shows in; `release` closes whatever held it before. */
  take: (surface: NoticeSurface, release: () => void) => void;
};

const NoticeSlotsContext = createContext<NoticeSlots | null>(null);

/** One per project, around every surface that shows notices. */
export function NoticeSlotsProvider({ children }: { children: ReactNode }) {
  // Keyed by surface in both shells, so a notice claimed before the shell
  // switched is still found: the desktop corner is one place every surface
  // shares, a phone's places are each surface's own.
  const holders = useRef(new Map<NoticeSurface, () => void>());
  const shared = usePhoneShell() === false;
  const take = useCallback(
    (surface: NoticeSurface, release: () => void) => {
      const held = holders.current;
      const replaced = shared ? [...held.values()] : [held.get(surface)];
      if (shared) held.clear();
      held.set(surface, release);
      for (const previous of replaced) previous?.();
    },
    [shared],
  );
  const value = useMemo(() => ({ take }), [take]);
  return <NoticeSlotsContext.Provider value={value}>{children}</NoticeSlotsContext.Provider>;
}

export function useNoticeSlot(): NoticeSlots {
  const slots = useContext(NoticeSlotsContext);
  if (!slots) throw new Error("NoticeSlotsProvider is required");
  return slots;
}

const CornerContext = createContext(false);

/** Below it, notices render as entries in the desktop Activity corner instead of inline. */
export function CornerNoticePlace({ children }: { children: ReactNode }) {
  return <CornerContext.Provider value>{children}</CornerContext.Provider>;
}

/**
 * Puts one notice in its place: inline where it is rendered, or, under
 * `CornerNoticePlace`, portaled into its own toast slot keyed by `id` (nothing
 * while the region folds it into "+N more"). Render it only while the notice exists.
 */
export function NoticePlacement({ id, children }: { id: string; children: ReactNode }) {
  const corner = useContext(CornerContext);
  const host = useToastSlot(corner ? `notice:${id}` : null);
  if (!corner) return children;
  return host ? createPortal(children, host) : null;
}

export type SurfaceNoticeModel = {
  message: ReactNode;
  /** A repair the notice offers beside its message, when Undo is not the answer. */
  action?: { label: ReactNode; run: () => void };
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
    <div
      className={cn(
        "min-w-0 rounded-md border border-border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-sm",
        className,
      )}
    >
      <div role="status" className="flex min-h-7 min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice.message}</span>
        {notice.action ? (
          <button
            type="button"
            className="text-button shrink-0 text-sm"
            onClick={notice.action.run}
          >
            {notice.action.label}
          </button>
        ) : null}
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
        <div role="alert" className="pb-0.5 text-destructive text-xs">
          {notice.failure}
        </div>
      ) : null}
    </div>
  );
}
