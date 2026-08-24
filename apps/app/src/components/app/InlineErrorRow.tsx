/**
 * InlineErrorRow — compact failed-load row for rail, popover, and list surfaces.
 */
import { Trans } from "@lingui/react/macro";
import { AlertCircle } from "lucide-react";
import type { ReactNode, RefObject } from "react";

export function InlineErrorRow({
  message,
  onRetry,
  retryRef,
}: {
  message: ReactNode;
  onRetry?: () => void;
  retryRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div role="alert" className="flex items-center gap-2 px-2 py-1.5">
      <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{message}</span>
      {onRetry ? (
        <button
          ref={retryRef}
          type="button"
          onClick={onRetry}
          className="text-button shrink-0 text-xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <Trans>Retry</Trans>
        </button>
      ) : null}
    </div>
  );
}
