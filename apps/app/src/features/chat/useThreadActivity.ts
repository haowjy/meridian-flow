/**
 * useThreadActivity — the live `ThreadActivity` + `ThreadStatus` for one viewed
 * thread's own subtree.
 *
 * Sources, in precedence order: the HTTP snapshot seeds the first render; the
 * `subscribed` live state reconciles on every (re)subscribe after catch-up so a
 * replayed frame frozen at emit time cannot win; `meridian.subagent.activity`
 * frames replace the activity live. Liveness stays out of the turn store by
 * construction.
 *
 * Lease expiry (a dead process) emits no journal event, so a replayed frame can
 * name a node `awake` after its lease has expired. We accept the subscribe-time
 * reconciliation as the correction: `subscribed.state.activity` is recomputed
 * from the live leases and always wins after catch-up. No lease-expiry activity
 * signal is added.
 */
import { EventType, type ThreadLiveState } from "@meridian/contracts/protocol";
import type { ThreadActivity, ThreadStatus } from "@meridian/contracts/threads";
import { useEffect, useRef, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useIsThreadPendingCreation } from "@/client/stores";
import { EMPTY_THREAD_ACTIVITY, isThreadActivity, subtreeOf } from "./thread-activity";

const ASLEEP: ThreadStatus = { kind: "asleep" };

export type ThreadActivityView = {
  activity: ThreadActivity;
  status: ThreadStatus;
};

export function useThreadActivity(input: {
  threadId: string;
  rootThreadId: string;
  seed: ThreadLiveState | null;
}): ThreadActivityView {
  const { threadId, rootThreadId, seed } = input;
  const transport = useThreadTransport();
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const [view, setView] = useState<ThreadActivityView>(() => seedView(seed));
  const prevThreadRef = useRef(threadId);
  const seededRef = useRef(false);

  useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      prevThreadRef.current = threadId;
      seededRef.current = seed !== null;
      setView(seedView(seed));
      return;
    }
    // The HTTP snapshot seeds once per thread. Later re-fetches are superseded
    // by live frames and the subscribe-time `onLiveState` reconciliation, so
    // they must not regress a newer live value.
    if (seed && !seededRef.current) {
      seededRef.current = true;
      setView(seedView(seed));
    }
  }, [seed, threadId]);

  useEffect(() => {
    if (isPendingCreation) return;
    return transport.subscribe(threadId, {
      onEvent: ({ event }) => {
        if (event.type !== EventType.CUSTOM || event.name !== "meridian.subagent.activity") return;
        if (!isThreadActivity(event.value)) return;
        // A frame carries the run-tree root's subtree; re-base it for a
        // non-root viewer. Root views receive their own subtree directly.
        const next = threadId === rootThreadId ? event.value : subtreeOf(event.value, threadId);
        setView((current) => ({ ...current, activity: next }));
      },
      onLiveState: (state) => {
        setView({ activity: state.activity ?? EMPTY_THREAD_ACTIVITY, status: state.status });
      },
    });
  }, [transport, threadId, rootThreadId, isPendingCreation]);

  return view;
}

function seedView(seed: ThreadLiveState | null): ThreadActivityView {
  return {
    activity: seed?.activity ?? EMPTY_THREAD_ACTIVITY,
    status: seed?.status ?? ASLEEP,
  };
}
