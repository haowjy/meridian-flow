/**
 * PhoneIconButton — shared 44px touch icon button for phone chrome.
 *
 * Project mobile chrome and account settings both need the same safe tap
 * target, focus ring, muted tone, and pressed feedback. The primitive lives in
 * `components/ui` rather than either feature so those cross-feature phone
 * surfaces do not copy a styling contract or import from each other.
 */
import type * as React from "react";

import { cn } from "@/lib/utils";

export function PhoneIconButton({
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "focus-ring grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground active:scale-[0.98]",
        className,
      )}
      {...props}
    />
  );
}
