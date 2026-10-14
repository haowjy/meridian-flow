/**
 * useProofLoop — the per-chat owner of the snapshot acquisitions the switch ledger waits on.
 *
 * The ledger names a bar (`need`): a switch no live source shows is settled only by a snapshot
 * whose request began above it. This loop drives that to completion from what the chat's
 * history host accepted, and from the query's errors:
 *
 * - it asks for one fetch and waits for that fetch's outcome: an accepted snapshot whose request
 *   began after the ask, or a new error. A fetch settles in the cache before the host's accepted
 *   snapshot is delivered, so the cache's own state is never read as the outcome, and a
 *   delivery that lags (or an older fetch's that arrives late) asks for nothing more;
 * - an accepted snapshot that does not exceed the bar (a fetch that began before the switch
 *   left, or a joined older one) is followed by one fresh fetch, which qualifies by
 *   construction, so there is no hot loop;
 * - a terminal query error is followed after 3 s, doubling per consecutive error up to 30 s.
 *   The host retries a rejected stale response (older than the thread's live changes) on its own
 *   250 ms schedule until the stream's floor is met, with `isFetching` held, so that never
 *   reaches this loop as an error;
 * - nothing is fetched while the browser is offline or the page is hidden, and the loop
 *   resumes on reconnect or when the page shows.
 */
import { onlineManager } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { snapshotRequestCount } from "@/client/query/thread-snapshot-query";

const RETRY_FIRST_MS = 3000;
const RETRY_MAX_MS = 30000;

/** Delay before the nth consecutive error (1-based) is retried. */
export const proofRetryDelay = (consecutiveErrors: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (consecutiveErrors - 1));

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/** Online, and the page shown: the only time a proof fetch is worth making. */
function usePageActive(): boolean {
  const online = useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
  return online && visible;
}

export function useProofLoop(input: {
  /** The bar a snapshot's request must exceed, or null when the ledger waits on nothing. */
  need: number | null;
  /** The snapshot the history host last accepted. */
  accepted: { requestSeq?: number } | null;
  /** When the snapshot query last failed terminally, 0 for never. */
  errorUpdatedAt: number;
  /** A snapshot fetch is in flight. */
  isFetching: boolean;
  /** Start one fresh acquisition. */
  acquire: () => void;
}): void {
  const { need, accepted, errorUpdatedAt, isFetching, acquire } = input;
  const active = usePageActive();
  /** `asked`: the request counter when the loop last asked; its fetch's request is above it. */
  const seen = useRef({
    accepted,
    errorAt: errorUpdatedAt,
    errors: 0,
    asked: null as number | null,
  });

  useEffect(() => {
    const state = seen.current;
    if (accepted !== state.accepted) {
      state.accepted = accepted;
      state.errors = 0;
      if (state.asked !== null && (accepted?.requestSeq ?? 0) > state.asked) state.asked = null;
    }
    if (errorUpdatedAt !== state.errorAt) {
      state.errorAt = errorUpdatedAt;
      state.errors += 1;
      state.asked = null;
    }
    const sufficient = need === null || (accepted?.requestSeq ?? 0) > need;
    if (!active || sufficient) state.asked = null;
    if (!active || sufficient || isFetching) return;
    const ask = () => {
      state.asked = snapshotRequestCount();
      acquire();
    };
    if (state.asked !== null) return;
    if (state.errors > 0) {
      const timer = setTimeout(ask, proofRetryDelay(state.errors));
      return () => clearTimeout(timer);
    }
    ask();
  }, [need, active, isFetching, accepted, errorUpdatedAt, acquire]);
}
