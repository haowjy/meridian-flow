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
  /** Stays with the notice when Undo goes or its message changes. */
  id: number;
  message: string;
  /** Absent when nothing moved. */
  undo: UndoMove | null;
  /** Puts focus back in the list the move came from, when the notice leaves under it. */
  refocus: () => void;
};

type NoticePublisher = {
  /** Shows a notice in place of any other; resolves to its id. */
  publish: (notice: Omit<Notice, "id">) => number;
  /** Drops the notice's Undo once nothing it would put back is still in place. */
  retire: (id: number) => void;
};

const HostContext = createContext<
  | (NoticePublisher & {
      notice: Notice | null;
      /** Replace or clear notice `id`, unless a newer notice has taken its place. */
      settle: (id: number, to: Notice | null) => void;
    })
  | null
>(null);

let nextNoticeId = 1;

/** Where a list in this surface publishes its drops; inert outside a host. */
export function useMoveNoticePublisher(): NoticePublisher | null {
  return useContext(HostContext);
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
  const publish = useCallback((next: Omit<Notice, "id">) => {
    const id = nextNoticeId++;
    if (!mounted.current) return id;
    setNotice({ ...next, id });
    announce(next.message);
    return id;
  }, []);
  const settle = useCallback((id: number, to: Notice | null) => {
    if (mounted.current) setNotice((now) => (now?.id === id ? to : now));
  }, []);
  const retire = useCallback((id: number) => {
    if (mounted.current)
      setNotice((now) => (now?.id === id && now.undo ? { ...now, undo: null } : now));
  }, []);
  const value = useMemo(
    () => ({ notice, publish, settle, retire }),
    [notice, publish, settle, retire],
  );
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function MoveNotice({ className }: { className?: string }) {
  const host = useContext(HostContext);
  if (!host) throw new Error("MoveNotice requires a MoveNoticeHost");
  const { notice: current, settle } = host;
  const [undoing, setUndoing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  if (!current) return null;

  // Asked before anything awaits: Undo's button disables while it runs and drops focus.
  const holdsFocus = () => ref.current?.contains(document.activeElement) ?? false;
  const close = (next: Notice | null, focused: boolean) => {
    settle(current.id, next);
    if (!next && focused) current.refocus();
  };

  const undo = async (put: UndoMove) => {
    const focused = holdsFocus();
    setUndoing(true);
    let next: Notice | null = null;
    try {
      const failure = await put();
      if (failure) next = { ...current, message: failure, undo: null };
    } catch {
      next = { ...current, message: t`Couldn't move it back.`, undo: null };
    } finally {
      setUndoing(false);
    }
    close(next, focused);
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
        onClick={() => close(null, holdsFocus())}
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

/** The warning before a move whose rows would arrive renamed; null when none would. */
export function describeRenames(renamed: readonly { name: string; as: string }[]): string | null {
  const [only] = renamed;
  if (!only) return null;
  if (renamed.length === 1) return t`${only.name} will be renamed ${only.as}`;
  return plural(renamed.length, {
    one: "# item will be renamed",
    other: "# items will be renamed",
  });
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
