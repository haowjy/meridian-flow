/**
 * "Moved chapter-3 to Act 2." with Undo, at the foot of the surface the rows
 * were dropped in: the sidebar, or Work Files (which stays on screen when the
 * sidebar is collapsed). One notice at a time; it leaves after a few seconds
 * unless the pointer or focus is on it. Undo puts the rows back.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState, useSyncExternalStore } from "react";
import { announce } from "@/client/stores";
import { cn } from "@/lib/utils";

/** Where a drop happened, so its notice shows there. */
export type MoveNoticeSurface = "sidebar" | "work-files";

type Notice = {
  id: number;
  surface: MoveNoticeSurface;
  message: string;
  undo: (() => Promise<void>) | null;
};

const VISIBLE_MS = 6000;

let notice: Notice | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: Notice | null) {
  notice = next;
  for (const listener of listeners) listener();
}

export function showMoveNotice(
  surface: MoveNoticeSurface,
  message: string,
  undo: (() => Promise<void>) | null,
) {
  set({ id: nextId++, surface, message, undo });
  announce(message);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function MoveNotice({
  surface,
  className,
}: {
  surface: MoveNoticeSurface;
  className?: string;
}) {
  const current = useSyncExternalStore(
    subscribe,
    () => (notice?.surface === surface ? notice : null),
    () => null,
  );
  const [held, setHeld] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // Leaving the surface ends its notice.
  useEffect(
    () => () => {
      if (notice?.surface === surface) set(null);
    },
    [surface],
  );
  useEffect(() => {
    if (!current || held || undoing) return;
    const timer = setTimeout(() => {
      if (notice?.id === current.id) set(null);
    }, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [current, held, undoing]);
  if (!current) return null;

  const undo = current.undo;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering only keeps the notice open.
    <div
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={cn(
        "z-20 flex items-center gap-2 rounded-md border border-border bg-popover px-2.5 py-2 text-sm text-popover-foreground shadow-sm",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{current.message}</span>
      {undo ? (
        <button
          type="button"
          disabled={undoing}
          onClick={async () => {
            setUndoing(true);
            try {
              await undo();
              if (notice?.id === current.id) set(null);
            } catch (error) {
              // The route names what failed; this is the fallback.
              const message = error instanceof Error ? error.message : t`Couldn't move it back.`;
              if (notice?.id === current.id) showMoveNotice(surface, message, null);
            } finally {
              setUndoing(false);
            }
          }}
          className="focus-ring shrink-0 rounded-md px-1.5 font-medium text-jade-text hover:underline"
        >
          <Trans>Undo</Trans>
        </button>
      ) : null}
    </div>
  );
}
