import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/core/lib/db";
import { useErrorStore } from "@/core/stores/useErrorStore";

interface ConnectivityQueueStatus {
  pendingCount: number;
  isSyncing: boolean;
}

/**
 * Observe pending offline queues and derive connectivity banner state.
 *
 * - `pendingCount`: pending document saves + pending tree ops
 * - `isSyncing`: online with pending items still queued
 */
export function useConnectivityQueueStatus(): ConnectivityQueueStatus {
  const isOffline = useErrorStore((s) => s.isOffline);

  const pendingCount =
    useLiveQuery(
      async () => {
        const [pendingSaves, pendingTreeOps] = await Promise.all([
          db.pendingDocumentSaves.count(),
          // No standalone `status` index exists; queue size is expected to stay small.
          db.pendingTreeOps.filter((op) => op.status === "pending").count(),
        ]);

        return pendingSaves + pendingTreeOps;
      },
      [],
      0,
    ) ?? 0;

  return {
    pendingCount,
    isSyncing: !isOffline && pendingCount > 0,
  };
}
