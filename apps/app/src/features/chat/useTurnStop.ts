/**
 * useTurnStop — Stop for a handoff brief being written, through the turn cancel
 * route. (A compaction divider's Stop is the chat's Stop, `useChatStop`.)
 *
 * The turn reads Stopping at once; the turn cancel route catches up and the
 * snapshot revalidates so the settled turn arrives. A failed cancel clears
 * Stopping and holds the failure on the turn, counted by attempt, until the
 * next attempt; `chatCards` draws it as the card on the row that offered Stop.
 */

import type { Occurrence } from "@meridian/thread-client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { announce } from "@/client/stores";

export type TurnStopCopy = { stopping: string };

export type TurnStop = {
  stopping: ReadonlySet<string>;
  /** The occurrence owned by each failed Stop. */
  failed: ReadonlyMap<string, Occurrence>;
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

/** Open failures carry the attempt allocated when Stop was pressed. */
type Failures = ReadonlyMap<string, Occurrence>;

export function useTurnStop(threadId: string): TurnStop {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Failures>(new Map());
  const attempts = useRef(new Map<string, number>());
  const queryClient = useQueryClient();
  const transport = useThreadTransport();

  const stop = useCallback(
    (turnId: string, copy: TurnStopCopy) => {
      const occurrence = {
        requestId: crypto.randomUUID(),
        attempt: (attempts.current.get(turnId) ?? 0) + 1,
      };
      attempts.current.set(turnId, occurrence.attempt);
      setStopping((current) => withId(current, turnId));
      setFailures((current) => {
        if (!current.has(turnId)) return current;
        const open = new Map(current);
        open.delete(turnId);
        return open;
      });
      announce(copy.stopping);
      transport.cancel(threadId, turnId).then(
        () => {
          void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
        },
        () => {
          setStopping((current) => withoutId(current, turnId));
          setFailures((current) => new Map(current).set(turnId, occurrence));
        },
      );
    },
    [queryClient, threadId, transport],
  );

  return { stopping, failed: failures, stop };
}
