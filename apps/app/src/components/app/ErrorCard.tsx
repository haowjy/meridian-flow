import { t } from "@lingui/core/macro";
import { CircleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export type ErrorCardProps = {
  /** The sentence and its controls, laid out on one row (Retry, Edit). */
  children: ReactNode;
  /** A line under the row, inside the card. */
  note?: ReactNode;
  /**
   * - `false` → full column width; the row wraps when the column is narrow.
   * - `true` → hugs its content and keeps the row on one line (a failure beside
   *   its controls). A sentence with no controls can set `whitespace-normal` on
   *   itself to wrap when the pane is narrower than the card.
   */
  inline?: boolean;
  /**
   * Whether the card is itself a live alert. Leave off when the surface already
   * has its own announcement or the card can appear from restored state.
   */
  announce?: boolean;
  /**
   * A failure the writer may leave as it is. Adds a small X ("Dismiss") at the end of
   * the row; the caller removes the card. Its touch target grows on coarse pointers
   * without making the row taller.
   */
  onDismiss?: () => void;
};

/**
 * The destructive-tinted card every chat failure uses: icon, a row for the
 * sentence and its controls, and an optional note beneath.
 */
export function ErrorCard({
  children,
  note,
  inline = false,
  announce = true,
  onDismiss,
}: ErrorCardProps) {
  return (
    <Alert
      variant="destructive"
      // `Alert` hardcodes role="alert" ahead of its spread props; undefined drops it.
      role={announce ? "alert" : undefined}
      className={cn(
        "border-destructive-border bg-destructive-tint shadow-none",
        "rounded-field py-[var(--chat-card-pad-y)]",
        // Inline is tightened so Retry and Edit fit the narrowest dock (280px) on one line.
        inline
          ? "w-fit px-[var(--chat-space-block)] has-[>svg]:gap-x-2"
          : "px-[var(--chat-card-pad-x)]",
      )}
    >
      <CircleAlert className="text-destructive" aria-hidden />
      <AlertDescription className="text-compact text-ink-muted">
        <div
          className={cn(
            "flex items-center",
            inline
              ? "flex-nowrap gap-x-[var(--chat-space-inline)] whitespace-nowrap"
              : "flex-wrap gap-x-[var(--chat-space-block)] gap-y-1",
          )}
        >
          {children}
          {onDismiss ? (
            <IconButton
              className="shrink-0 [@media(pointer:coarse)]:-my-2.5 [@media(pointer:coarse)]:size-11"
              aria-label={t`Dismiss`}
              onClick={onDismiss}
            >
              <X aria-hidden className="size-3.5" />
            </IconButton>
          ) : null}
        </div>
        {note}
      </AlertDescription>
    </Alert>
  );
}
