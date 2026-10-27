/**
 * InlineErrorRow — compact failed-load or failed-command row for rail, popover,
 * header, and list surfaces.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AlertCircle, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export function InlineErrorRow({
  message,
  onRetry,
  actionLabel,
  retryRef,
  onDismiss,
  wrap = false,
}: {
  message: ReactNode;
  onRetry?: () => void;
  actionLabel?: ReactNode;
  retryRef?: RefObject<HTMLButtonElement | null>;
  /** A failed command the writer may leave as it is. */
  onDismiss?: () => void;
  /** Let a long message wrap, for dialogs where the words are the point. */
  wrap?: boolean;
}) {
  return (
    <div role="alert" className="flex items-center gap-2 px-2 py-1.5">
      <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span
        className={cn("min-w-0 flex-1 text-xs text-foreground", wrap ? "break-words" : "truncate")}
      >
        {message}
      </span>
      {onRetry ? (
        <button
          ref={retryRef}
          type="button"
          onClick={onRetry}
          className="text-button shrink-0 text-xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          {actionLabel ?? <Trans>Retry</Trans>}
        </button>
      ) : null}
      {onDismiss ? (
        <IconButton
          className="shrink-0 [@media(pointer:coarse)]:size-11"
          aria-label={t`Dismiss`}
          onClick={onDismiss}
        >
          <X aria-hidden className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  );
}
