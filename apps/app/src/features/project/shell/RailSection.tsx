/**
 * RailSection — building blocks for lists drawn in the tree's own parts: a chat's
 * Scratch. Section heads are `ListSectionHeader`, rows wear
 * `contextTreeFileRowClassName` with the tree's `RowIcon`, and the hint takes the
 * sidebar's hint role.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import { RowIcon, rowPaddingLeft } from "../context/ContextTreeRows";
import { contextTreeFileRowClassName } from "../context/context-row-geometry";

/** One folder row, as the tree draws it: the open or closed folder is its disclosure. */
export function RailFolderRow({
  icon,
  name,
  expanded,
  onToggle,
  depth = 1,
}: {
  icon: LucideIcon;
  name: string;
  expanded: boolean;
  onToggle: () => void;
  depth?: number;
}) {
  return (
    <div
      className={contextTreeFileRowClassName(false)}
      style={{ paddingLeft: rowPaddingLeft(depth) }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="focus-ring flex min-w-0 flex-1 items-center self-stretch rounded-md text-left"
      >
        <RowIcon icon={icon} />
        <span className="ml-0.5 min-w-0 flex-1 truncate">{name}</span>
      </button>
    </div>
  );
}

/** A line standing in for a section's rows (loading, empty), starting where its rows' icons do. */
export function RailEmptyHint({ children }: { children: ReactNode }) {
  return (
    <p
      className={cn("pr-2 leading-snug", role.emptyLine)}
      style={{ paddingLeft: ROW_INSET_PX + rowPaddingLeft(1) }}
    >
      {children}
    </p>
  );
}

/** The `mx-2` a row sits inside its list with. */
const ROW_INSET_PX = 8;
