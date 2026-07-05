/**
 * InlineErrorRow — compact failed-load row for rail, popover, and list surfaces.
 */
import { Trans } from "@lingui/react/macro";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

export function InlineErrorRow({ message, onRetry }: { message: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="text-button shrink-0 text-xs">
          <Trans>Retry</Trans>
        </button>
      ) : null}
    </div>
  );
}
