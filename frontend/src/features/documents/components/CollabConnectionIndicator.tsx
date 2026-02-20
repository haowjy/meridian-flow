import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/shared/components/ui/tooltip";
import type { CollabConnectionState } from "../stores/useCollabStore";

const stateConfig: Record<
  CollabConnectionState,
  { dotClass: string; label: string; tooltip: string }
> = {
  connected: {
    dotClass: "bg-success",
    label: "Connected",
    tooltip: "Collaboration connected",
  },
  syncing: {
    dotClass: "bg-warning animate-pulse",
    label: "Syncing",
    tooltip: "Collaboration syncing",
  },
  disconnected: {
    dotClass: "bg-error",
    label: "Disconnected",
    tooltip: "Collaboration disconnected",
  },
};

interface CollabConnectionIndicatorProps {
  state: CollabConnectionState;
  className?: string;
}

export function CollabConnectionIndicator({
  state,
  className,
}: CollabConnectionIndicatorProps) {
  const { dotClass, label, tooltip } = stateConfig[state];

  return (
    <SimpleTooltip content={tooltip}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full outline-none",
          "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-offset-1",
          className,
        )}
        role="img"
        tabIndex={0}
        aria-label={`Collaboration status: ${label}`}
      >
        <span className={cn("size-1.5 rounded-full", dotClass)} />
      </span>
    </SimpleTooltip>
  );
}
