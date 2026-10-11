import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type ErrorCardProps = {
  /** The sentence and its controls, laid out on one row (Retry, Edit). */
  children: ReactNode;
  /** A line under the row, inside the card. */
  note?: ReactNode;
  /**
   * - `false` → full column width; the row wraps when the column is narrow.
   * - `true` → hugs its content and never wraps (a writer-row failure).
   */
  inline?: boolean;
  /**
   * Whether the card is itself a live alert. Leave off when the surface already
   * has its own announcement or the card can appear from restored state.
   */
  announce?: boolean;
};

/**
 * The destructive-tinted card every chat failure uses: icon, a row for the
 * sentence and its controls, and an optional note beneath.
 */
export function ErrorCard({ children, note, inline = false, announce = true }: ErrorCardProps) {
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
        </div>
        {note}
      </AlertDescription>
    </Alert>
  );
}
