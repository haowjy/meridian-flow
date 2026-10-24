/**
 * "Moved chapter-3 to Act 2." with Undo, at the foot of the surface that took
 * the move (a drop or Move…). A surface that can take moves (the sidebar, or
 * Work Files, which stays on screen when the sidebar is collapsed) wraps its
 * lists in a `MoveNoticeHost`; a list publishes to the host it sits in. The
 * host holds its latest notice as state, so one notice shows per host and a
 * host that has left the screen takes its notice with it. The notice sits in
 * the surface's own layout, never over other controls, and stays until the
 * next move, Dismiss, or the host leaving: Undo is not a race.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { announce } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import type { MoveResult } from "./execute-move";

/** Puts the move back; resolves to what to say when some of it couldn't go back. */
type UndoMove = () => Promise<string | null>;

type Notice = {
  message: string;
  /** Absent when nothing moved. */
  undo: UndoMove | null;
};

type Publish = (message: string, undo: UndoMove | null) => void;

const HostContext = createContext<{
  notice: Notice | null;
  publish: Publish;
  /** Replace or clear `from`, unless a newer notice has taken its place. */
  settle: (from: Notice, to: Notice | null) => void;
} | null>(null);

/** Where a list in this surface publishes its drops; inert outside a host. */
export function useMoveNoticePublisher(): Publish | null {
  return useContext(HostContext)?.publish ?? null;
}

/** A surface that takes drops and shows their notice (`MoveNotice`) somewhere inside it. */
export function MoveNoticeHost({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A drop can finish after its surface has gone; there is nowhere to say so.
  const publish = useCallback<Publish>((message, undo) => {
    if (!mounted.current) return;
    setNotice({ message, undo });
    announce(message);
  }, []);
  const settle = useCallback((from: Notice, to: Notice | null) => {
    if (mounted.current) setNotice((now) => (now === from ? to : now));
  }, []);
  const value = useMemo(() => ({ notice, publish, settle }), [notice, publish, settle]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function MoveNotice({ className }: { className?: string }) {
  const host = useContext(HostContext);
  if (!host) throw new Error("MoveNotice requires a MoveNoticeHost");
  const { notice: current, settle } = host;
  const [undoing, setUndoing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  if (!current) return null;

  // The notice leaves under the focused button; focus goes to the rows it was about.
  const close = (next: Notice | null) => {
    const scope = ref.current?.parentElement;
    const refocus = !next && ref.current?.contains(document.activeElement);
    settle(current, next);
    if (!refocus || !scope) return;
    const row =
      scope.querySelector<HTMLElement>('[data-entry-key][aria-pressed="true"]') ??
      scope.querySelector<HTMLElement>("[data-entry-key]");
    row?.focus();
  };

  const undo = async (put: UndoMove) => {
    setUndoing(true);
    let next: Notice | null = null;
    try {
      const failure = await put();
      if (failure) next = { message: failure, undo: null };
    } catch {
      next = { message: t`Couldn't move it back.`, undo: null };
    } finally {
      setUndoing(false);
    }
    close(next);
    if (next) announce(next.message);
  };

  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-popover py-1 pr-1 pl-2.5 text-sm text-popover-foreground",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{current.message}</span>
      {current.undo ? (
        <Button
          variant="link"
          size="meta"
          disabled={undoing}
          onClick={() => current.undo && void undo(current.undo)}
          className="text-jade-text"
        >
          <Trans>Undo</Trans>
        </Button>
      ) : null}
      <IconButton
        className="shrink-0 [@media(pointer:coarse)]:size-11"
        aria-label={t`Dismiss`}
        onClick={() => close(null)}
      >
        <X aria-hidden className="size-3.5" />
      </IconButton>
    </div>
  );
}

/**
 * "Moved 3 items to Act 2." and, when the replica refused some, which. A lone
 * row that arrived under the next free name says so.
 */
export function describeMove(result: MoveResult, destinationName: string): string {
  const { moved, failed } = result;
  const parts: string[] = [];
  const [first] = moved;
  if (moved.length === 1 && first && first.previousName !== first.name)
    parts.push(t`Moved ${first.previousName} to ${destinationName} as ${first.name}.`);
  else if (moved.length === 1 && first) parts.push(t`Moved ${first.name} to ${destinationName}.`);
  else if (moved.length > 1)
    parts.push(
      plural(moved.length, {
        one: `Moved # item to ${destinationName}.`,
        other: `Moved # items to ${destinationName}.`,
      }),
    );
  const [lost] = failed;
  if (failed.length === 1 && lost) parts.push(t`Couldn't move ${lost.name}.`);
  else if (failed.length > 1)
    parts.push(
      plural(failed.length, { one: "Couldn't move # item.", other: "Couldn't move # items." }),
    );
  return parts.join(" ");
}

/** Null when every row went back. */
export function describeUndoFailure({ failed }: MoveResult): string | null {
  if (failed.length === 0) return null;
  const [lost] = failed;
  if (failed.length === 1 && lost) return t`Couldn't move ${lost.name} back.`;
  return plural(failed.length, {
    one: "Couldn't move # item back.",
    other: "Couldn't move # items back.",
  });
}
