import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

export function WorkTitleLine({
  title,
  status,
  size = "row",
}: {
  title: ReactNode;
  status: string | null | undefined;
  size?: "row" | "heading";
}) {
  return (
    <div className={cn("flex min-w-0 items-center", size === "heading" ? "gap-3" : "gap-2")}>
      {title}
      {status ? (
        <div className="flex min-w-0 max-w-2/5 shrink-0">
          <Chip kind="label">
            <span className="truncate">{status}</span>
          </Chip>
        </div>
      ) : null}
    </div>
  );
}
