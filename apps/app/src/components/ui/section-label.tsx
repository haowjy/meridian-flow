/**
 * SectionLabel — the name above a group of rows or a settings section, in the app's one
 * group-label look (`role.groupLabel`). Pass `className` only for layout.
 */
import type * as React from "react";

import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";

export function SectionLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="section-label" className={cn(role.groupLabel, className)} {...props} />;
}
