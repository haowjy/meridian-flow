/**
 * Failure toasts: `notifyFailure` from anywhere, one `FailureToaster` at the app root. Only for a
 * failure that has no place of its own on a document or in the import popup; a success never
 * toasts. A failure stays until dismissed, except a `brief` one, a slip from the writer's own
 * action, which goes by itself. `visibleToasts` caps how many show at once. Every toast is one
 * floating pill, drawn as the app's menus are: the failure's category ("Couldn't apply", "Sign-in
 * expired"), a short `reason` only where running it again would fail the same way, at most one
 * action, and a close. Cause and consequence go to the console (`detail`), never into the pill.
 * Closing only hides it.
 */
import { t } from "@lingui/core/macro";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { dropdownPanelClass } from "@/components/ui/dropdown-presentation";
import { role } from "@/components/ui/roles";

const BRIEF_MS = 5000;

/** The open toast under each key. Each toast has its own Sonner id: reusing one races its exit. */
const shown = new Map<string, string | number>();

export function notifyFailure({
  key,
  title,
  reason,
  action,
  brief,
  detail,
}: {
  /** This failure's own: a second toast under one key replaces the first. */
  key: string;
  /** The failure's category: "Couldn't copy". A longer title is cut to one line. */
  title: ReactNode;
  /** Why it failed, in two to four words, only where Retry would fail the same way: "Too many imports". */
  reason?: string;
  /** The one way on: Retry where running it again can help, or what fixes it ("Log in"). */
  action?: { label: string; run: () => void | Promise<void> };
  /** A one-line error that follows from the writer's action and loses nothing: it goes away soon. */
  brief?: true;
  /** What went wrong, for whoever debugs it: logged, never shown. */
  detail?: unknown;
}) {
  if (detail !== undefined) console.warn(`[failure] ${key}`, detail);
  dismissFailure(key);
  const owns = () => shown.get(key) === id;
  const label = reason ? (
    <>
      {title} <span className={role.secondary}>{reason}</span>
    </>
  ) : (
    title
  );
  const id = toast.error(label, {
    duration: brief ? BRIEF_MS : Number.POSITIVE_INFINITY,
    onDismiss: () => {
      if (owns()) shown.delete(key);
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
// Sized to its words and centred (`inset-x-0 mx-auto w-fit`). The `!`s beat Sonner's phone rules, which
// stretch each toast to the screen and give the list `width: 100%` on top of its side offsets.
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
      className="max-[600px]:w-auto!"
      containerAriaLabel={t`Failures`}
      icons={{ error: <CircleAlert aria-hidden className="size-4 text-destructive" /> }}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: t`Dismiss`,
        classNames: {
          toast: `pointer-events-auto inset-x-0 mx-auto flex w-fit! max-w-[min(24rem,100%)] items-center gap-2 py-1 pr-1 pl-3 ${dropdownPanelClass} ${role.row}`,
          icon: "flex shrink-0",
          content: "min-w-0 flex-1",
          title: "truncate",
          description: "mt-1.5 mb-0.5 w-full select-text",
          actionButton: "text-button shrink-0 coarse:min-h-11 coarse:min-w-11",
          closeButton: `order-last ${buttonVariants({ variant: "quiet", size: "icon-xs" })}`,
        },
      }}
    />
  );
}
