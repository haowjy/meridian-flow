/**
 * useProofLoop — the per-chat owner of the snapshot acquisitions the switch ledger waits on.
 *
 * The ledger names a bar (`need`): a switch no live source shows is settled only by a snapshot
 * whose request began above it. This loop drives that to completion, from what the snapshot
 * query settles to rather than from changes to the bar alone:
 *
 * - an insufficient success (its request not above the bar: a fetch that began before the
 *   switch left, or a joined older one) is followed at once by one fresh fetch, which
 *   qualifies by construction, so there is no hot loop;
 * - an error is followed after 3 s, doubling per consecutive error up to 30 s;
 * - nothing is fetched while the browser is offline or the page is hidden, and the loop
 *   resumes on reconnect or when the page shows.
 */
import { onlineManager } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";

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
  /** The snapshot query's settled state. */
  snapshot: {
    requestSeq: number | undefined;
    dataUpdatedAt: number;
    errorUpdatedAt: number;
    isFetching: boolean;
  };
  /** Start one fresh acquisition. */
  acquire: () => void;
}): void {
  const { need, acquire } = input;
  const { requestSeq, dataUpdatedAt, errorUpdatedAt, isFetching } = input.snapshot;
  const active = usePageActive();
  const errors = useRef({ at: 0, count: 0 });

  useEffect(() => {
    if (need === null || !active || isFetching) return;
    if (errorUpdatedAt > dataUpdatedAt) {
      if (errors.current.at !== errorUpdatedAt)
        errors.current = { at: errorUpdatedAt, count: errors.current.count + 1 };
      const timer = setTimeout(acquire, proofRetryDelay(errors.current.count));
      return () => clearTimeout(timer);
    }
    errors.current = { at: 0, count: 0 };
    if ((requestSeq ?? 0) <= need) acquire();
  }, [need, active, isFetching, requestSeq, dataUpdatedAt, errorUpdatedAt, acquire]);
}
