/**
 * The project lists' shared row grammar: a list ruled between its rows, the
 * row's leading icon, and a group's label. Work lists, Work files, deleted
 * Works and the recency lists all build from these.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

export type RuledRow = { key: string; node: ReactNode };

/** Rows with a hairline between each and the next; none under the last. */
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

/** A row's leading icon, in the row's text rank. */
export function RowIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span className={cn("grid size-[18px] shrink-0 place-items-center text-ink-subtle", className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/** A group's label with the space under it; the caller owns the space above. */
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
      <SectionLabel variant="group">{children}</SectionLabel>
    </Tag>
  );
}
