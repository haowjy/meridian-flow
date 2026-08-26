/** Read-only Work identity shared by Composer controls and metadata surfaces. */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function WorkIdentity({
  name,
  unavailableLabel,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  name: string | null | undefined;
  unavailableLabel: string;
}) {
  return (
    <span
      className={cn("min-w-0 truncate text-xs font-medium text-foreground", className)}
      {...props}
    >
      {name || unavailableLabel}
    </span>
  );
}
