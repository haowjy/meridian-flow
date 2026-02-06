import { WifiOff } from "lucide-react";
import { useErrorStore } from "@/core/stores/useErrorStore";

/**
 * Fixed banner at top of viewport showing offline status.
 *
 * Only renders when offline. Auto-hides when back online.
 * Uses warning colors (orange/yellow) to indicate temporary issue.
 */
export function NetworkStatusBanner() {
  const isOffline = useErrorStore((s) => s.isOffline);

  if (!isOffline) return null;

  return (
    <div
      className="bg-warning text-warning-foreground fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 px-4 py-2"
      role="alert"
      aria-live="polite"
    >
      <WifiOff className="h-4 w-4" />
      <span className="text-sm font-medium">
        You're offline. Changes will sync when you're back online.
      </span>
    </div>
  );
}
