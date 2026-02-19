import { Loader2, WifiOff } from "lucide-react";
import { useConnectivityQueueStatus } from "@/core/hooks/useConnectivityQueueStatus";
import { useErrorStore } from "@/core/stores/useErrorStore";

/**
 * Fixed banner at top of viewport showing offline and sync queue status.
 *
 * Renders when:
 * - Offline (with optional pending count)
 * - Online while pending queues are draining
 */
export function NetworkStatusBanner() {
  const isOffline = useErrorStore((s) => s.isOffline);
  const { pendingCount, isSyncing } = useConnectivityQueueStatus();

  if (!isOffline && !isSyncing) return null;

  const message = isOffline
    ? pendingCount > 0
      ? `Offline - ${pendingCount} change${pendingCount === 1 ? "" : "s"} saved locally`
      : "Offline"
    : `Syncing... (${pendingCount} remaining)`;

  return (
    <div
      className={
        isOffline
          ? "bg-warning text-warning-foreground fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 px-4 py-2"
          : "bg-muted text-foreground fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b px-4 py-2"
      }
      role="status"
      aria-live="polite"
    >
      {isOffline ? (
        <WifiOff className="h-4 w-4" />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin" />
      )}
      <span className="text-sm font-medium">{message}</span>
    </div>
  );
}
