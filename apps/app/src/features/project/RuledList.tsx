import type { ReactNode } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

export type RuledRow = { key: string; node: ReactNode };

export function RuledList({ rows, className }: { rows: readonly RuledRow[]; className?: string }) {
  return (
    <ul className={cn("min-w-0", className)}>
      {rows.map(({ key, node }, index) => (
        <li key={key} className={cn("relative", index < rows.length - 1 && "row-rule")}>
          {node}
        </li>
      ))}
    </ul>
  );
}

export function GroupLabel({
  children,
  as: Tag = "div",
  className,
}: {
  children: ReactNode;
  as?: "div" | "h2";
  className?: string;
}) {
  return (
    <Tag className={cn("pb-2", className)}>
      <SectionLabel>{children}</SectionLabel>
    </Tag>
  );
}
