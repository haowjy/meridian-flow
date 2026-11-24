import { t } from "@lingui/core/macro";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { dropdownPanelClass } from "@/components/ui/dropdown-presentation";
import { role } from "@/components/ui/roles";

const BRIEF_MS = 5000;

// keep: Each toast needs its own Sonner id; reusing one races its exit
const shown = new Map<string, string | number>();

export function notifyFailure({
  key,
  title,
  reason,
  action,
  brief,
  detail,
}: {
  key: string;
  title: ReactNode;
  reason?: string;
  action?: { label: string; run: () => void | Promise<void> };
  brief?: true;
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

export function dismissFailure(key: string) {
  const id = shown.get(key);
  if (id === undefined) return;
  shown.delete(key);
  toast.dismiss(id);
}

export function dismissFailures(prefix: string) {
  for (const key of [...shown.keys()]) if (key.startsWith(prefix)) dismissFailure(key);
}

const DESKTOP_OFFSET = { top: "3rem" };
const PHONE_OFFSET = {
  top: "calc(env(safe-area-inset-top) + 3.5rem + 0.5rem)",
  left: "0.5rem",
  right: "0.5rem",
};

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
