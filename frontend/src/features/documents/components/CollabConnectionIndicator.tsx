import { cn } from "@/lib/utils";
import type { CollabConnectionState } from "../stores/useCollabStore";

const stateConfig: Record<
  CollabConnectionState,
  { dotClass: string; label: string }
> = {
  connected: { dotClass: "bg-success", label: "Connected" },
  syncing: { dotClass: "bg-warning animate-pulse", label: "Syncing" },
  disconnected: { dotClass: "bg-error", label: "Disconnected" },
};

interface CollabConnectionIndicatorProps {
  state: CollabConnectionState;
  className?: string;
}

export function CollabConnectionIndicator({
  state,
  className,
}: CollabConnectionIndicatorProps) {
  const { dotClass, label } = stateConfig[state];

  return (
    <div
      className={cn("flex items-center gap-1.5 text-xs text-muted", className)}
      aria-label={`Connection status: ${label}`}
    >
      <span className={cn("size-1.5 rounded-full", dotClass)} />
      <span>{label}</span>
    </div>
  );
}
