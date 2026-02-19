import { useEffect } from "react";
import {
  initializeRetryProcessor,
  cleanupRetryProcessor,
} from "@/core/lib/sync";
import {
  initPersistentSaveDrain,
  cleanupPersistentSaveDrain,
} from "@/core/lib/persistentSaveDrain";

/**
 * Provider component that initializes background sync processors.
 *
 * - In-memory RetryScheduler: general-purpose retry infrastructure
 *   (no longer used for document saves; kept for potential future use)
 * - Persistent save drain: retries failed document saves from IndexedDB,
 *   survives page reload, and drains on startup + `online` event + periodic tick
 */
export function SyncProvider() {
  useEffect(() => {
    initializeRetryProcessor();
    initPersistentSaveDrain();

    return () => {
      cleanupRetryProcessor();
      cleanupPersistentSaveDrain();
    };
  }, []);

  // This component doesn't render anything
  return null;
}
