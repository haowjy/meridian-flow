/**
 * useTurnStop — Stop for a handoff brief being written, through the turn cancel
 * route. (A compaction divider's Stop is the chat's Stop, `useChatStop`.)
 *
 * The turn reads Stopping at once; the turn cancel route catches up and the
 * snapshot revalidates so the settled turn arrives. A failed cancel clears
 * Stopping and holds the failure on the turn, counted by attempt, until the
 * next attempt; `chatCards` draws it as the card on the row that offered Stop.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce } from "@/client/stores";

export type TurnStopCopy = { stopping: string };

export type TurnStop = {
  stopping: ReadonlySet<string>;
  /** Turns whose last Stop failed, with how many Stops have failed on each (the card's occurrence). */
  failed: ReadonlyMap<string, number>;
  stop: (turnId: string, copy: TurnStopCopy) => void;
};

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set(set).add(id);
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

/** Tallies failed Stops per turn; `failures` survives a retry so a second failure is a new occurrence. */
type Failures = { open: ReadonlyMap<string, number>; total: ReadonlyMap<string, number> };

export function useTurnStop(threadId: string): TurnStop {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Failures>({ open: new Map(), total: new Map() });
  const queryClient = useQueryClient();
  const transport = useThreadTransport();

  const stop = useCallback(
    (turnId: string, copy: TurnStopCopy) => {
      setStopping((current) => withId(current, turnId));
      setFailures((current) => {
        if (!current.open.has(turnId)) return current;
        const open = new Map(current.open);
        open.delete(turnId);
        return { ...current, open };
      });
      announce(copy.stopping);
      transport.cancel(threadId, turnId).then(
        () => {
          void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
        },
        () => {
          setStopping((current) => withoutId(current, turnId));
          setFailures((current) => {
            const count = (current.total.get(turnId) ?? 0) + 1;
            return {
              open: new Map(current.open).set(turnId, count),
              total: new Map(current.total).set(turnId, count),
            };
          });
        },
      );
    },
    [queryClient, threadId, transport],
  );

  return { stopping, failed: failures.open, stop };
}
