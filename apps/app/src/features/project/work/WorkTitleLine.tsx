/**
 * A Work's name with its status beside it: the AI's short word for where the
 * Work stands (Drafting, Blocked, Done). The status is read-only for the
 * writer, so it is a quiet label, never a control; no status, no label.
 * This row owns the layout: the name truncates first, and the status never
 * takes more than two fifths of the line before it truncates itself.
 */
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function WorkTitleLine({
  title,
  status,
  size = "row",
}: {
  /** The name, which truncates itself; a list row's text or the page heading. */
  title: ReactNode;
  status: string | null | undefined;
  /** `row` beside a list row's name; `heading` beside the page title. */
  size?: "row" | "heading";
}) {
  return (
    <div className={cn("flex min-w-0 items-center", size === "heading" ? "gap-3" : "gap-2")}>
      {title}
      {status ? (
        <div className="flex min-w-0 max-w-2/5 shrink-0">
          <Badge variant="label" size={size === "heading" ? "lg" : "default"}>
            <span className="truncate">{status}</span>
          </Badge>
        </div>
      ) : null}
    </div>
  );
}
