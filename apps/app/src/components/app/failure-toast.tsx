/**
 * Failure toasts: `notifyFailure` from anywhere, one `FailureToaster` at the app root. Only for a
 * failure that has no place of its own on a document or in the import popup; a success never
 * toasts. A failure stays until dismissed, except a `brief` one, a slip from the writer's own
 * action, which goes by itself. `visibleToasts` caps how many show at once. Every toast is one
 * floating pill: the failure's category ("Couldn't apply", "Sign-in expired"), at most one action,
 * and a close. Cause and consequence go to the console (`detail`), never into the pill.
 */
import { t } from "@lingui/core/macro";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";

const BRIEF_MS = 5000;

/** The open toast under each key. Each toast has its own Sonner id: reusing one races its exit. */
const shown = new Map<string, string | number>();

export function notifyFailure({
  key,
  title,
  action,
  onClose,
  brief,
  detail,
}: {
  /** This failure's own: a second toast under one key replaces the first. */
  key: string;
  /** The failure's category: "Couldn't copy". A longer title is cut to one line. */
  title: ReactNode;
  /** The one way on: Retry where running it again can help, or what fixes it ("Log in"). */
  action?: { label: string; run: () => void | Promise<void> };
  /** The writer closed it. */
  onClose?: () => void;
  /** A one-line error that follows from the writer's action and loses nothing: it goes away soon. */
  brief?: true;
  /** What went wrong, for whoever debugs it: logged, never shown. */
  detail?: unknown;
}) {
  if (detail !== undefined) console.warn(`[failure] ${key}`, detail);
  dismissFailure(key);
  const owns = () => shown.get(key) === id;
  const id = toast.error(title, {
    duration: brief ? BRIEF_MS : Number.POSITIVE_INFINITY,
    onDismiss: () => {
      if (!owns()) return;
      shown.delete(key);
      onClose?.();
    },
    action: action
      ? {
          label: action.label,
          onClick: () => {
            if (owns()) shown.delete(key);
            void action.run();
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
// Sized to its words and centred (`inset-x-0 mx-auto w-fit`); `!` beats Sonner's phone rule that stretches each toast to the screen.
export function FailureToaster() {
  return (
    <Toaster
      position="top-center"
      offset={DESKTOP_OFFSET}
      mobileOffset={PHONE_OFFSET}
      closeButton
      expand
      visibleToasts={3}
      gap={6}
      containerAriaLabel={t`Failures`}
      icons={{ error: <CircleAlert aria-hidden className="size-3.5 text-destructive" /> }}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: t`Dismiss`,
        classNames: {
          toast:
            "pointer-events-auto inset-x-0 mx-auto flex h-8 w-fit! max-w-[min(24rem,100%)] items-center gap-2 rounded-full border border-border bg-card pr-1 pl-3 text-compact text-foreground shadow-float coarse:h-11",
          icon: "flex shrink-0",
          content: "min-w-0",
          title: "truncate",
          actionButton: "text-button shrink-0 text-compact coarse:min-h-11",
          closeButton:
            "focus-ring order-last flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground coarse:size-11 [&_svg]:size-3",
        },
      }}
    />
  );
}
