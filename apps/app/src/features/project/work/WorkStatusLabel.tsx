/**
 * A Work's status: the AI's short word for where the Work stands (Drafting,
 * Blocked, Done). Read-only for the writer, so it is a quiet label beside the
 * Work's name, never a control. No status, no label.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function WorkStatusLabel({
  status,
  size = "row",
  className,
}: {
  status: string | null | undefined;
  /** `heading` sits beside the page title; `row` beside a list row's name. */
  size?: "row" | "heading";
  className?: string;
}) {
  if (!status) return null;
  return (
    <Badge
      className={cn(
        "min-w-0 max-w-full py-px font-medium tracking-normal text-muted-foreground",
        size === "heading" && "px-2 py-0.5 text-xs",
        className,
      )}
    >
      <span className="truncate">{status}</span>
    </Badge>
  );
}
