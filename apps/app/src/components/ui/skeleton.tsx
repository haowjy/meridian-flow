/**
 * Skeleton — shadcn loading-placeholder primitive (animated muted block).
 * Upstream-managed wrapper; customize via `cn()` + tokens at call sites.
 */
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  );
}

export { Skeleton };
