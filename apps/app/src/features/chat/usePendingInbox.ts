/**
 * usePendingInbox — the live undelivered inbox for one viewed thread.
 *
 * Sources, in precedence order: the HTTP snapshot seeds the first render; the
 * `subscribed` live state reconciles on every (re)subscribe so a replayed frame
 * frozen at emit time cannot win; `meridian.inbox.changed` frames replace the
 * tray live (enqueue adds a row, ack clears it). The tray is server truth, never
 * a turn block.
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
    return transport.subscribe(threadId, {
      onEvent: ({ event }) => {
        const next = pendingInboxFromEvent(event);
        if (next) setPending(next);
      },
      onLiveState: (state) => setPending(state.pending ?? EMPTY_THREAD_PENDING_INBOX),
    });
  }, [transport, threadId]);

  return pending;
}
