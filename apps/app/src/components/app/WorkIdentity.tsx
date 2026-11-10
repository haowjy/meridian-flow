import { Layers } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** How a Work reads wherever one is named: the Work glyph, then its name. */
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
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground",
        className,
      )}
      {...props}
    >
      <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{name || unavailableLabel}</span>
    </span>
  );
}
