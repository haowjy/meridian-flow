import { useEffect } from "react";
import {
  initializeRetryProcessor,
  cleanupRetryProcessor,
} from "@/core/lib/sync";
import {
  initPersistentSaveDrain,
  cleanupPersistentSaveDrain,
} from "@/core/lib/persistentSaveDrain";
import {
  initTreeQueueDrain,
  cleanupTreeQueueDrain,
} from "@/core/lib/treeQueueDrain";

/**
 * Provider component that initializes background sync processors.
 *
 * - In-memory RetryScheduler: general-purpose retry infrastructure
 *   (no longer used for document saves; kept for potential future use)
 * - Persistent save drain: retries failed document saves from IndexedDB,
 *   survives page reload, and drains on startup + `online` event + periodic tick
 * - Tree queue drain: replays queued tree mutations (rename/move/delete) on
 *   reconnect + periodic tick, with conflict-aware error handling
 */
export function SyncProvider() {
  useEffect(() => {
    initializeRetryProcessor();
    initPersistentSaveDrain();
    initTreeQueueDrain();

    return () => {
      cleanupRetryProcessor();
      cleanupPersistentSaveDrain();
      cleanupTreeQueueDrain();
    };
  }, []);

  // This component doesn't render anything
  return null;
}
