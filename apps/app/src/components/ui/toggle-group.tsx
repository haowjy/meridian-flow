/**
 * ToggleGroup — shadcn/Radix toggle-group primitive (segmented control).
 * Upstream-managed wrapper; customize via `cn()` + tokens at call sites.
 */
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex items-center", className)}
      {...props}
    />
  );
}

function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn("focus-ring transition-colors", className)}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
