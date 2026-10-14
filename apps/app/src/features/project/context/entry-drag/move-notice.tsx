/**
 * "Moved chapter-3 to Act 2." with Undo, at the foot of the surface the rows
 * were dropped in. A surface that can take drops (the sidebar, or Work Files,
 * which stays on screen when the sidebar is collapsed) wraps its lists in a
 * `MoveNoticeHost`; a list publishes to the host it sits in. A project keeps
 * its latest result only, as data: one notice at a time, shown by the host
 * that took the drop. It leaves after a few seconds unless the pointer or
 * focus is on it, and a host that has left the screen takes its notice with it.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useWorks } from "@/client/query/useWorks";
import { announce } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAccountResourceReplica } from "../account-feature-context";
import { type MoveResult, undoMove } from "./execute-move";
import type { MoveEffect } from "./move-plan";

const VISIBLE_MS = 6000;

type Notice = {
  id: number;
  host: object;
  message: string;
  /** What Undo puts back; empty when nothing moved. */
  effects: readonly MoveEffect[];
};

const latest = new Map<string, Notice>();
const hosts = new Set<object>();
const listeners = new Set<() => void>();
let nextId = 1;

function set(projectId: string, notice: Notice | null) {
  if (notice) latest.set(projectId, notice);
  else latest.delete(projectId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Publish = (message: string, effects: readonly MoveEffect[]) => void;

const HostContext = createContext<{ host: object; projectId: string; publish: Publish } | null>(
  null,
);

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
  const host = useMemo(() => ({}), []);
  useEffect(() => {
    hosts.add(host);
    return () => {
      hosts.delete(host);
      if (latest.get(projectId)?.host === host) set(projectId, null);
    };
  }, [host, projectId]);
  const value = useMemo(
    () => ({
      host,
      projectId,
      // A drop can finish after its surface has gone; there is nowhere to say so.
      publish: (message: string, effects: readonly MoveEffect[]) => {
        if (!hosts.has(host)) return;
        set(projectId, { id: nextId++, host, message, effects });
        announce(message);
      },
    }),
    [host, projectId],
  );
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function MoveNotice({ className }: { className?: string }) {
  const hostContext = useContext(HostContext);
  if (!hostContext) throw new Error("MoveNotice requires a MoveNoticeHost");
  return <Notice {...hostContext} className={className} />;
}

function Notice({
  projectId,
  host,
  publish,
  className,
}: {
  projectId: string;
  host: object;
  publish: Publish;
  className?: string;
}) {
  const resources = useAccountResourceReplica();
  const { works, noWork } = useWorks(projectId);
  const current = useSyncExternalStore(
    subscribe,
    () => {
      const notice = latest.get(projectId);
      return notice?.host === host ? notice : null;
    },
    () => null,
  );
  const [held, setHeld] = useState(false);
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    if (!current || held || undoing) return;
    const timer = setTimeout(() => {
      if (latest.get(projectId)?.id === current.id) set(projectId, null);
    }, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [current, held, undoing, projectId]);
  if (!current) return null;

  const undo = async () => {
    setUndoing(true);
    try {
      const result = await undoMove(current.effects, { resources, projectId, works, noWork });
      if (latest.get(projectId)?.id !== current.id) return;
      if (result.failed.length > 0) publish(describeUndoFailure(result), []);
      else set(projectId, null);
    } catch {
      if (latest.get(projectId)?.id === current.id) publish(t`Couldn't move it back.`, []);
    } finally {
      setUndoing(false);
    }
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
