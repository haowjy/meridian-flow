/**
 * usePendingInbox — the live undelivered inbox for one viewed thread.
 *
 * Sources, in precedence order: the HTTP snapshot seeds the first render; the
 * `subscribed` live state reconciles on every (re)subscribe; inbox events replace
 * state wholesale. Epoch fencing prevents a late frame from an old thread owner
 * from overwriting the mounted thread's queue statuses.
 */
import type { ThreadLiveState } from "@meridian/contracts/protocol";
import type { ThreadPendingInbox } from "@meridian/contracts/threads";
import { useEffect, useRef, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { EMPTY_THREAD_PENDING_INBOX, pendingInboxFromEvent } from "./pending-inbox";

export function usePendingInbox(input: {
  threadId: string;
  seed: ThreadLiveState | null;
}): ThreadPendingInbox {
  const { threadId, seed } = input;
  const transport = useThreadTransport();
  const [pending, setPending] = useState<ThreadPendingInbox>(
    () => seed?.pending ?? EMPTY_THREAD_PENDING_INBOX,
  );
  const prevThreadRef = useRef(threadId);
  const seededRef = useRef(false);
  const subscriptionEpoch = useRef(0);

  useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      prevThreadRef.current = threadId;
      seededRef.current = seed !== null;
      setPending(seed?.pending ?? EMPTY_THREAD_PENDING_INBOX);
      return;
    }
    // The HTTP snapshot seeds once per thread; later re-fetches must not regress
    // a newer live value.
    if (seed && !seededRef.current) {
      seededRef.current = true;
      setPending(seed.pending ?? EMPTY_THREAD_PENDING_INBOX);
    }
  }, [seed, threadId]);

  useEffect(() => {
    const epoch = ++subscriptionEpoch.current;
    const unsubscribe = transport.subscribe(threadId, {
      onEvent: ({ event }) => {
        if (subscriptionEpoch.current !== epoch) return;
        const next = pendingInboxFromEvent(event);
        if (next) setPending(next);
      },
      onLiveState: (state) => {
        if (subscriptionEpoch.current === epoch)
          setPending(state.pending ?? EMPTY_THREAD_PENDING_INBOX);
      },
    });
    return () => {
      subscriptionEpoch.current += 1;
      unsubscribe();
    };
  }, [transport, threadId]);

  return pending;
}
