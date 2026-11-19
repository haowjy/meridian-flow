/**
 * Failure toasts: `notifyFailure` from anywhere, one `FailureToaster` at the app root. Only for a
 * failure that has no place of its own on a document or in the import popup; a success never
 * toasts. A failure stays until dismissed, except a `brief` one, a slip from the writer's own
 * action, which goes by itself. `visibleToasts` caps how many show at once. Every toast is one
 * floating pill, so a brief error and a lasting one look alike.
 */
import { t } from "@lingui/core/macro";
import { CircleAlert } from "lucide-react";
import { Toaster, toast } from "sonner";
import { usePhoneShell } from "@/hooks/use-phone-shell";

const BRIEF_MS = 5000;

/** The open toast under each key. Each toast has its own Sonner id: reusing one races its exit. */
const shown = new Map<string, string | number>();

export function notifyFailure({
  key,
  title,
  onRetry,
  onClose,
  brief,
}: {
  /** This failure's own: a second toast under one key replaces the first. */
  key: string;
  /** Names what failed: "Couldn't move Chapter 3 to Act 2." */
  title: string;
  /** Only where running it again can help. */
  onRetry?: () => void | Promise<void>;
  /** The writer closed it. */
  onClose?: () => void;
  /** A one-line error that follows from the writer's action and loses nothing: it goes away soon. */
  brief?: true;
}) {
  dismissFailure(key);
  const owns = () => shown.get(key) === id;
  const id = toast.error(title, {
    duration: brief ? BRIEF_MS : Number.POSITIVE_INFINITY,
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
  shown.set(key, id);
}

/** Closes a failure that no longer applies, without counting as the writer closing it. */
export function dismissFailure(key: string) {
  const id = shown.get(key);
  if (id === undefined) return;
  shown.delete(key);
  toast.dismiss(id);
}

/** Closes every failure under a key prefix, such as a project's on leaving it. */
export function dismissFailures(prefix: string) {
  for (const key of [...shown.keys()]) if (key.startsWith(prefix)) dismissFailure(key);
}

/** Centred under the header on desktop, below the top bar on a phone. */
const DESKTOP_OFFSET = { top: "3rem" };
const PHONE_OFFSET = {
  top: "calc(env(safe-area-inset-top) + 3.5rem + 0.5rem)",
  left: "0.5rem",
  right: "0.5rem",
};

// `pointer-events-auto`: an open modal sets `pointer-events: none` on the body, which the toast would inherit.
export function FailureToaster() {
  const phone = usePhoneShell();
  return (
    <Toaster
      position="top-center"
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
            "pointer-events-auto flex w-full items-center gap-2 rounded-full border border-border bg-card py-1.5 pr-1.5 pl-4 text-sm text-foreground shadow-float",
          content: "min-w-0 flex-1",
          title: "[overflow-wrap:anywhere]",
          actionButton: "text-button shrink-0 text-sm coarse:min-h-11",
          closeButton:
            "focus-ring order-last flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground coarse:size-11",
        },
      }}
    />
  );
}
