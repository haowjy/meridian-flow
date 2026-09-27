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
import { useEffect, useSyncExternalStore } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useIsThreadPendingCreation } from "@/client/stores";
import { EMPTY_THREAD_ACTIVITY, isThreadActivity, subtreeOf } from "./thread-activity";

const ASLEEP: ThreadStatus = { kind: "asleep" };
type SharedActivity = {
  view: ThreadActivityView;
  listeners: Set<() => void>;
  release?: () => void;
  refs: number;
  seeded: boolean;
};
const shared = new Map<string, SharedActivity>();

function stateFor(threadId: string): SharedActivity {
  let state = shared.get(threadId);
  if (!state) {
    state = { view: seedView(null), listeners: new Set(), refs: 0, seeded: false };
    shared.set(threadId, state);
  }
  return state;
}

function publish(state: SharedActivity, view: ThreadActivityView) {
  state.view = view;
  for (const listener of state.listeners) listener();
}

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
  const state = stateFor(threadId);
  const view = useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.view,
    () => state.view,
  );

  useEffect(() => {
    if (seed && !state.seeded) {
      state.seeded = true;
      publish(state, seedView(seed));
    }
  }, [seed, state]);

  useEffect(() => {
    if (!threadId || isPendingCreation) return;
    state.refs += 1;
    if (state.refs === 1)
      state.release = transport.subscribe(threadId, {
        onEvent: ({ event }) => {
          if (event.type !== EventType.CUSTOM || event.name !== "meridian.subagent.activity")
            return;
          if (!isThreadActivity(event.value)) return;
          // A frame carries the run-tree root's subtree; re-base it for a
          // non-root viewer. Root views receive their own subtree directly.
          const next = threadId === rootThreadId ? event.value : subtreeOf(event.value, threadId);
          state.seeded = true;
          publish(state, { ...state.view, activity: next });
        },
        onLiveState: (liveState) => {
          state.seeded = true;
          publish(state, {
            activity: liveState.activity ?? EMPTY_THREAD_ACTIVITY,
            status: liveState.status,
          });
        },
      });
    return () => {
      state.refs -= 1;
      if (state.refs === 0) {
        state.release?.();
        state.release = undefined;
      }
    };
  }, [transport, threadId, rootThreadId, isPendingCreation, state]);

  return view;
}

function seedView(seed: ThreadLiveState | null): ThreadActivityView {
  return {
    activity: seed?.activity ?? EMPTY_THREAD_ACTIVITY,
    status: seed?.status ?? ASLEEP,
  };
}
