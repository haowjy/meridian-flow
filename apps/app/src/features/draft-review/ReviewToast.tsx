/** Transient feedback for a change that disappeared elsewhere. Successful dispositions need no toast: optimistic UI shows their result. */
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import type { ReviewToast as ReviewToastValue } from "./draft-review-session";

const VISIBLE_MS = 3500;

export function ReviewToast({
  toast,
  onDismiss,
  className,
}: {
  toast: ReviewToastValue | null;
  onDismiss: (id: number) => void;
  /** Where the host wants it (the phone lifts it above the change bar). */
  className?: string;
}) {
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined || toast?.unsentText) return;
    const timer = window.setTimeout(() => onDismiss(id), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [id, onDismiss, toast?.unsentText]);

  if (!toast) return null;
  return (
    <div
      role="status"
      data-review-toast={toast.code}
      className={cn(
        "pointer-events-auto absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md px-3 py-1.5 text-caption shadow-card",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none",
        "bg-foreground text-background",
        className,
      )}
    >
      {toast.code === "draft-closed" ? <Trans>This draft was discarded.</Trans> : null}
      {toast.unsentText ? (
        <details>
          <summary>
            <Trans>Copy unsent text</Trans>
          </summary>
          <pre className="max-h-48 max-w-md select-text overflow-auto whitespace-pre-wrap">
            {toast.unsentText}
          </pre>
          <button type="button" className="text-button" onClick={() => onDismiss(toast.id)}>
            <Trans>Dismiss</Trans>
          </button>
        </details>
      ) : null}
      {toast.code === "change-gone" ? <Trans>That change is no longer in the draft.</Trans> : null}
    </div>
  );
}
