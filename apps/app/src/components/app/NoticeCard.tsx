/** The one card every chat note uses: a failure (error) or a fact the writer should know (info). */
import { t } from "@lingui/core/macro";
import { CircleAlert, Info, X } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export type NoticeCardProps = {
  /** `error` is destructive-tinted with an alert icon; `info` is quiet with an info icon. */
  tone: "error" | "info";
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
   * Whether the card announces itself (`alert` for errors, `status` for info).
   * Leave off when the surface already has its own announcement or the card can
   * appear from restored state.
   */
  announce?: boolean;
  /**
   * A note the writer may leave as it is. Adds a small X ("Dismiss") at the far end
   * of the row; the caller removes the card. Its touch target grows on coarse pointers
   * without making the row taller.
   */
  onDismiss?: () => void;
};

export function NoticeCard({
  tone,
  children,
  note,
  inline = false,
  announce = true,
  onDismiss,
}: NoticeCardProps) {
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      // `Alert` hardcodes role="alert" ahead of its spread props; undefined drops it.
      role={announce ? (tone === "error" ? "alert" : "status") : undefined}
      className={cn(
        tone === "error"
          ? "border-destructive-border bg-destructive-tint"
          : "border-border bg-muted",
        "rounded-field py-[var(--chat-card-pad-y)] shadow-none",
        // Inline is tightened so Retry and Edit fit the narrowest dock (280px) on one line.
        inline
          ? "w-fit px-[var(--chat-space-block)] has-[>svg]:gap-x-2"
          : "px-[var(--chat-card-pad-x)]",
      )}
    >
      <Icon className={tone === "error" ? "text-destructive" : "text-ink-subtle"} aria-hidden />
      <AlertDescription className="text-compact text-ink-muted">
        <div
          className={cn(
            "flex items-center",
            inline
              ? "flex-nowrap gap-x-[var(--chat-space-inline)] whitespace-nowrap"
              : // The description grid starts its items; the row spans it so the X reaches the end.
                "w-full flex-wrap gap-x-[var(--chat-space-block)] gap-y-1",
          )}
        >
          {children}
          {onDismiss ? (
            <IconButton
              // At the row's end even when the card is wider than its sentence.
              className="ml-auto shrink-0 [@media(pointer:coarse)]:-my-2.5 [@media(pointer:coarse)]:size-11"
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
