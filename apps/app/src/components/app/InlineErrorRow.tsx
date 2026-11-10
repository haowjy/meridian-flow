/**
 * InlineErrorRow — the one error line: a red icon, the message in body ink, and at most
 * one text action. Rails, popovers, headers, lists, dialogs and fields all use it; a
 * caller sets only the inset (`className`).
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
  id,
  className,
}: {
  message: ReactNode;
  onRetry?: () => void;
  actionLabel?: ReactNode;
  retryRef?: RefObject<HTMLButtonElement | null>;
  /** A failed command the writer may leave as it is. */
  onDismiss?: () => void;
  /** Let a long message wrap, for dialogs where the words are the point. */
  wrap?: boolean;
  /** For a field's `aria-describedby`. */
  id?: string;
  /** The host's inset, replacing the default `px-2 py-1.5`. */
  className?: string;
}) {
  return (
    <div
      id={id}
      role="alert"
      className={cn("flex items-center gap-2 px-2 py-1.5", wrap && "items-start", className)}
    >
      <AlertCircle
        className={cn("size-3.5 shrink-0 text-destructive", wrap && "mt-px")}
        aria-hidden
      />
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
