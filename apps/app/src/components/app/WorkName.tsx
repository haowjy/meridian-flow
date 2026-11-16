import type { ReactNode } from "react";
import { useWorks } from "@/client/query/useWorks";
import { cn } from "@/lib/utils";
import { type WorkRef, workDisplayName } from "@/lib/work-name";

/**
 * A Work's name wherever the writer reads one, with its handle beside it when another Work in
 * the project shares the name (`repeatedNameHandles`). The name truncates first; the handle
 * stays whole, since it is what tells the two apart. A sentence or an accessible name uses the
 * string form, `useWorks(projectId).nameOf`.
 */
export function WorkName({
  work,
  className,
  children,
}: {
  work: WorkRef;
  className?: string;
  /** The name as this place draws it (a heading that renames in place), instead of plain text. */
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
