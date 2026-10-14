/**
 * "Moved chapter-3 to Act 2." with Undo, at the foot of the surface the rows
 * were dropped in. A surface that can take drops (the sidebar, or Work Files,
 * which stays on screen when the sidebar is collapsed) wraps its lists in a
 * `MoveNoticeHost`; a list publishes to the host it sits in. The host holds its
 * latest notice as state, so one notice shows per host and a host that has
 * left the screen takes its notice with it. It leaves after a few seconds
 * unless the pointer or focus is on it.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
import { cn } from "@/lib/utils";
import { useAccountResourceReplica } from "../account-feature-context";
import { type MoveResult, undoMove } from "./execute-move";
import type { MoveEffect } from "./move-plan";

const VISIBLE_MS = 6000;

type Notice = {
  message: string;
  /** What Undo puts back; empty when nothing moved. */
  effects: readonly MoveEffect[];
};

type Publish = (message: string, effects: readonly MoveEffect[]) => void;

const HostContext = createContext<{
  projectId: string;
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
export function MoveNoticeHost({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A drop can finish after its surface has gone; there is nowhere to say so.
  const publish = useCallback<Publish>((message, effects) => {
    if (!mounted.current) return;
    setNotice({ message, effects });
    announce(message);
  }, []);
  const settle = useCallback((from: Notice, to: Notice | null) => {
    if (mounted.current) setNotice((now) => (now === from ? to : now));
  }, []);
  const value = useMemo(
    () => ({ projectId, notice, publish, settle }),
    [projectId, notice, publish, settle],
  );
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function MoveNotice({ className }: { className?: string }) {
  const host = useContext(HostContext);
  if (!host) throw new Error("MoveNotice requires a MoveNoticeHost");
  const { projectId, notice: current, settle } = host;
  const resources = useAccountResourceReplica();
  const [held, setHeld] = useState(false);
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    if (!current || held || undoing) return;
    const timer = setTimeout(() => settle(current, null), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [current, held, undoing, settle]);
  if (!current) return null;

  const undo = async () => {
    setUndoing(true);
    let next: Notice | null = null;
    try {
      const result = await undoMove(current.effects, { resources, projectId });
      if (result.failed.length > 0) next = { message: describeUndoFailure(result), effects: [] };
    } catch {
      next = { message: t`Couldn't move it back.`, effects: [] };
    } finally {
      setUndoing(false);
    }
    settle(current, next);
    if (next) announce(next.message);
  };

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
      {current.effects.length > 0 ? (
        <Button
          variant="link"
          size="meta"
          disabled={undoing}
          onClick={() => void undo()}
          className="text-jade-text"
        >
          <Trans>Undo</Trans>
        </Button>
      ) : null}
    </div>
  );
}

/** "Moved 3 items to Act 2." and, when the replica refused some, which. */
export function describeMove(result: MoveResult, destinationName: string): string {
  const { moved, failed } = result;
  const parts: string[] = [];
  const [first] = moved;
  if (moved.length === 1 && first) parts.push(t`Moved ${first.name} to ${destinationName}.`);
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

function describeUndoFailure({ failed }: MoveResult): string {
  const [lost] = failed;
  if (failed.length === 1 && lost) return t`Couldn't move ${lost.name} back.`;
  return plural(failed.length, {
    one: "Couldn't move # item back.",
    other: "Couldn't move # items back.",
  });
}
