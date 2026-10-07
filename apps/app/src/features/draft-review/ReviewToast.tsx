/**
 * ReviewToast — the small confirmation after a change is applied or discarded.
 * It says what happened and nothing more: per-change Undo does not exist, so it
 * offers none. Reads from the controller and dismisses itself.
 */
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";

import type { ReviewToast as ReviewToastValue } from "@/features/chat/draft-review-session";
import { cn } from "@/lib/utils";

const VISIBLE_MS = 3500;

export function ReviewToast({
  toast,
  onDismiss,
}: {
  toast: ReviewToastValue | null;
  onDismiss: (id: number) => void;
}) {
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined) return;
    const timer = window.setTimeout(() => onDismiss(id), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [id, onDismiss]);

  if (!toast) return null;
  return (
    <div
      role="status"
      data-review-toast={toast.code}
      className={cn(
        "pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md px-3 py-1.5 text-caption shadow-card",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none",
        toast.tone === "error" ? "bg-foreground text-background" : "bg-foreground text-background",
      )}
    >
      {toast.code === "applied" ? <Trans>Applied</Trans> : null}
      {toast.code === "discarded" ? <Trans>Discarded</Trans> : null}
      {toast.code === "change-gone" ? <Trans>That change is no longer in the draft.</Trans> : null}
    </div>
  );
}
