/**
 * InlineErrorRow — the one error line: a red icon, the message in body ink, and at most
 * one text action. Rails, popovers, headers, lists, dialogs and fields all use it; a
 * caller sets only the inset (`className`). The message wraps: an error cut off with an
 * ellipsis can't be read.
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
  id,
  className,
}: {
  message: ReactNode;
  onRetry?: () => void;
  actionLabel?: ReactNode;
  retryRef?: RefObject<HTMLButtonElement | null>;
  /** A failed command the writer may leave as it is. */
  onDismiss?: () => void;
  /** For a field's `aria-describedby`. */
  id?: string;
  /** The host's inset, replacing the default `px-2 py-1.5`. */
  className?: string;
}) {
  return (
    <div id={id} role="alert" className={cn("flex items-start gap-2 px-2 py-1.5", className)}>
      <AlertCircle className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 break-words text-xs text-foreground">{message}</span>
      {onRetry ? (
        <button
          ref={retryRef}
          type="button"
          onClick={onRetry}
          className="text-button shrink-0 text-xs coarse:min-h-11 coarse:min-w-11"
        >
          {actionLabel ?? <Trans>Retry</Trans>}
        </button>
      ) : null}
      {onDismiss ? (
        <IconButton className="shrink-0" label={t`Dismiss`} onClick={onDismiss}>
          <X aria-hidden className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  );
}
