// @ts-nocheck
/**
 * ProcessDisclosure — default-collapsed shell for Thinking process history.
 *
 * Purpose: Owns only the disclosure chrome, animation, aria wiring, and sticky
 * user toggle state. Callers compose the fold body because the process history
 * can now contain mixed reasoning rows and completed activity runs. The key
 * decision is that this shell always starts closed; streaming status must not
 * auto-open or force-close it, so live and settled turns keep the same layout.
 *
 * Body chrome is intentionally bare — no left border, no inset padding. Each
 * `ActivityRow` paints its own piece of the timeline rail inside its icon
 * column, so the gutter is already structurally connected; a competing
 * blockquote border around the fold body would just clutter it.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

export type ProcessDisclosureProps = {
  label: ReactNode;
  children: ReactNode;
};

export function ProcessDisclosure({ label, children }: ProcessDisclosureProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const handleToggle = () => {
    setOpen((value) => !value);
  };

  return (
    <div className="mb-3 py-1.5">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="disclosure-trigger justify-start"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
          aria-hidden
        />
        <span className="font-medium">{label}</span>
      </button>

      <div
        id={panelId}
        data-process-fold
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </div>
  );
}
