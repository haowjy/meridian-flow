/**
 * useTurnStop — Stop for a turn that has no reply stream: a pending
 * compaction divider or a handoff brief being written.
 *
 * The turn reads Stopping at once; the turn cancel route catches up and the
 * snapshot revalidates so the settled turn arrives. A failed cancel clears
 * Stopping and records the failure on the turn until the next attempt, so
 * the row that offered Stop can say so.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce, announceError } from "@/client/stores";

export type TurnStopCopy = { stopping: string; failed: string };

export type TurnStop = {
  stopping: ReadonlySet<string>;
  /** Turns whose last Stop failed. */
  failed: ReadonlySet<string>;
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

export function useTurnStop(threadId: string): TurnStop {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const queryClient = useQueryClient();
  const transport = useThreadTransport();

  const stop = useCallback(
    (turnId: string, copy: TurnStopCopy) => {
      setStopping((current) => withId(current, turnId));
      setFailed((current) => withoutId(current, turnId));
      announce(copy.stopping);
      transport.cancel(threadId, turnId).then(
        () => {
          void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
        },
        () => {
          setStopping((current) => withoutId(current, turnId));
          setFailed((current) => withId(current, turnId));
          announceError(copy.failed);
        },
      );
    },
    [queryClient, threadId, transport],
  );

  return { stopping, failed, stop };
}
