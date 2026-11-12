/** A list heading's action button (`ListSectionHeader` `actions`). */

import type { LucideIcon } from "lucide-react";
import type React from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/** One header action (VS Code Explorer-header anatomy): ~20px hit target around a 16px icon, transparent at rest, rail hover tint + icon darken on hover, focus-ring for keyboard. */
export function PaneHeaderActionButton({
  icon: Icon,
  iconClassName,
  label,
  children,
  ...props
}: {
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
} & React.ComponentPropsWithoutRef<"button">) {
  return (
    <IconButton
      size="xs"
      label={label}
      {...props}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick?.(event);
      }}
      className="relative size-5 rounded-sm"
    >
      <Icon aria-hidden className={cn("size-4", iconClassName)} />
      {children}
    </IconButton>
  );
}
