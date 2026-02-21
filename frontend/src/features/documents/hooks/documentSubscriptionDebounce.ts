/**
 * Debounced document subscription manager.
 *
 * Prevents subscribe/unsubscribe churn during React StrictMode double-mount
 * by delaying unsubscribe by a configurable debounce period (default 100ms).
 * If the same document re-subscribes before the timer fires, the pending
 * unsubscribe is canceled — the subscription stays alive.
 */

export interface DocumentSubscriptionDebounceOptions {
  /** Debounce delay in milliseconds (default: 100). */
  debounceMs?: number;
  /** Timer implementation for testability. */
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
}

interface PendingUnsubscribe {
  timerId: number;
}

export interface DocumentSubscriptionDebounce {
  /**
   * Mark a document as subscribed. Cancels any pending debounced unsubscribe
   * for this document.
   */
  subscribe: (documentId: string) => void;

  /**
   * Schedule a debounced unsubscribe for a document. If subscribe() is called
   * for the same document before the timer fires, the unsubscribe is canceled.
   *
   * @param documentId - document to unsubscribe
   * @param doUnsubscribe - callback that performs the actual unsubscribe
   */
  scheduleUnsubscribe: (documentId: string, doUnsubscribe: () => void) => void;

  /**
   * Cancel all pending timers. Call on teardown to prevent leaks.
   */
  destroy: () => void;
}

export function createDocumentSubscriptionDebounce(
  options: DocumentSubscriptionDebounceOptions = {},
): DocumentSubscriptionDebounce {
  const debounceMs = options.debounceMs ?? 100;
  const setTimerFn =
    options.setTimer ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number);
  const clearTimerFn = options.clearTimer ?? ((id: number) => clearTimeout(id));

  const pendingUnsubscribes = new Map<string, PendingUnsubscribe>();

  const cancelPending = (documentId: string): boolean => {
    const pending = pendingUnsubscribes.get(documentId);
    if (!pending) {
      return false;
    }
    clearTimerFn(pending.timerId);
    pendingUnsubscribes.delete(documentId);
    return true;
  };

  return {
    subscribe(documentId: string) {
      cancelPending(documentId);
    },

    scheduleUnsubscribe(documentId: string, doUnsubscribe: () => void) {
      // Cancel any existing pending unsubscribe for this document
      cancelPending(documentId);

      const timerId = setTimerFn(() => {
        pendingUnsubscribes.delete(documentId);
        doUnsubscribe();
      }, debounceMs);

      pendingUnsubscribes.set(documentId, { timerId });
    },

    destroy() {
      for (const [, pending] of pendingUnsubscribes) {
        clearTimerFn(pending.timerId);
      }
      pendingUnsubscribes.clear();
    },
  };
}
