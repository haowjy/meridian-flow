import { Layers } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import type { WorkRef } from "@/lib/work-name";
import { WorkName } from "./WorkName";

/** How a Work reads wherever one is named as a value: the Work glyph, then its `WorkName`. */
export function WorkIdentity({
  work,
  unavailableLabel,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  work: WorkRef | null | undefined;
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
      {work ? (
        <WorkName work={work} />
      ) : (
        <span className="min-w-0 truncate">{unavailableLabel}</span>
      )}
    </span>
  );
}
