import { Layers } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { type WorkNaming, workDisplayName } from "@/lib/work-name";

/** How a Work reads wherever one is named: the Work glyph, then its name as the writer reads it. */
export function WorkIdentity({
  work,
  handle,
  unavailableLabel,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  work: WorkNaming | null | undefined;
  /** Its handle, where another Work shares its name (`WorkHandleOf`). */
  handle?: string | null;
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
      <span className="min-w-0 truncate">
        {(work && workDisplayName(work)) || unavailableLabel}
      </span>
      <WorkHandle handle={handle} />
    </span>
  );
}

/**
 * A Work's handle beside its name, for a name another Work shares. The name truncates first; the
 * handle stays whole, since it is what tells the two apart.
 */
export function WorkHandle({ handle }: { handle: string | null | undefined }) {
  if (!handle) return null;
  return (
    <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums">
      {handle}
    </span>
  );
}
