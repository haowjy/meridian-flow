/**
 * Failure toasts: `notifyFailure` from anywhere, one `FailureToaster` at the app root. Only for a
 * failure that has no place of its own on a document or in the import popup; a success never
 * toasts. A failure stays until dismissed or replaced by the next one under its key.
 */
import { t } from "@lingui/core/macro";
import { CircleAlert } from "lucide-react";
import { Toaster, toast } from "sonner";
import { usePhoneShell } from "@/hooks/use-phone-shell";

/** The open toast under each key. Each toast has its own Sonner id: reusing one races its exit. */
const shown = new Map<string, { id: string | number; onClose?: () => void }>();

export function notifyFailure({
  key,
  title,
  onRetry,
  onClose,
}: {
  /** What this failure replaces: the kind of work that failed, not the row. */
  key: string;
  /** Names what failed: "Couldn't move Chapter 3 to Act 2." */
  title: string;
  /** Only where running it again can help. */
  onRetry?: () => void | Promise<void>;
  /** The writer closed it, or a newer failure replaced it. Not called after Retry. */
  onClose?: () => void;
}) {
  const previous = shown.get(key);
  dismissFailure(key);
  previous?.onClose?.();
  const owns = () => shown.get(key)?.id === id;
  const id = toast.error(title, {
    duration: Number.POSITIVE_INFINITY,
    onDismiss: () => {
      if (!owns()) return;
      shown.delete(key);
      onClose?.();
    },
    action: onRetry
      ? {
          label: t`Retry`,
          onClick: () => {
            if (owns()) shown.delete(key);
            void onRetry();
          },
        }
      : undefined,
  });
  shown.set(key, { id, onClose });
}

/** Closes a failure that no longer applies, without counting as the writer closing it. */
export function dismissFailure(key: string) {
  const open = shown.get(key);
  if (!open) return;
  shown.delete(key);
  toast.dismiss(open.id);
}

/** Below the dock's header on desktop, below the top bar on a phone. */
const DESKTOP_OFFSET = { top: "3rem", right: "1rem" };
const PHONE_OFFSET = {
  top: "calc(env(safe-area-inset-top) + 3.5rem + 0.5rem)",
  left: "0.5rem",
  right: "0.5rem",
};

export function FailureToaster() {
  const phone = usePhoneShell();
  return (
    <Toaster
      position={phone ? "top-center" : "top-right"}
      offset={DESKTOP_OFFSET}
      mobileOffset={PHONE_OFFSET}
      closeButton
      expand
      visibleToasts={3}
      containerAriaLabel={t`Failures`}
      icons={{ error: <CircleAlert aria-hidden className="size-4 text-destructive" /> }}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: t`Dismiss`,
        classNames: {
          toast:
            "flex w-full items-center gap-2 rounded-md border border-border bg-popover py-2 pr-2 pl-3 text-sm text-popover-foreground shadow-card",
          content: "min-w-0 flex-1",
          title: "[overflow-wrap:anywhere]",
          actionButton: "text-button shrink-0 text-sm [@media(pointer:coarse)]:min-h-11",
          closeButton:
            "focus-ring order-last flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:size-11",
        },
      }}
    />
  );
}
