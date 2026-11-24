import type { ReactNode } from "react";
import { useWorks } from "@/client/query/useWorks";
import { cn } from "@/lib/utils";
import { type WorkRef, workDisplayName } from "@/lib/work-name";

export function WorkName({
  work,
  className,
  children,
}: {
  work: WorkRef;
  className?: string;
  children?: ReactNode;
}) {
  const { handleOf } = useWorks(work.projectId);
  const handle = handleOf(work);
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      {children ?? <span className="min-w-0 truncate">{workDisplayName(work)}</span>}
      {handle ? (
        <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums">
          {handle}
        </span>
      ) : null}
    </span>
  );
}
