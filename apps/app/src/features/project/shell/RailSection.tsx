/**
 * RailSection — building blocks for lists drawn in the tree's own parts: the
 * right context rail's Recent and a chat's Scratch. Section heads are
 * `RailPaneHeader`, rows wear `contextTreeFileRowClassName` with the tree's
 * `RowIcon`, and the hint takes the sidebar's hint role.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import { RowIcon, rowPaddingLeft } from "../context/ContextTreeRows";
import { contextTreeFileRowClassName } from "../context/context-row-geometry";
import { RailPaneHeader } from "../context/RailPaneHeader";
import { type RailSectionId, useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";

/** A collapsible section under a tree-style head. The tree's heads show no counts, so neither does this. */
export function CollapsibleRailSection({
  title,
  icon,
  preferenceId,
  children,
}: {
  title: string;
  icon: LucideIcon;
  preferenceId: RailSectionId;
  children: ReactNode;
}) {
  const expanded = useProjectSurfacePrefsStore(
    (state) => state.railPrefs[`${preferenceId}Expanded`],
  );
  const setExpanded = useProjectSurfacePrefsStore((state) => state.setRailExpanded);
  return (
    <section>
      <RailPaneHeader
        label={title}
        icon={icon}
        expanded={expanded}
        onExpandedChange={(next) => setExpanded(preferenceId, next)}
      />
      {expanded ? <div>{children}</div> : null}
    </section>
  );
}

/** One file row, as the tree draws it. */
export function RailFileRow({
  icon,
  name,
  title,
  onOpen,
  active = false,
  depth = 1,
}: {
  icon: LucideIcon;
  name: string;
  title?: string;
  onOpen: () => void;
  /** The document is open beside the writer; the row keeps the tree's selected fill. */
  active?: boolean;
  depth?: number;
}) {
  return (
    <div
      className={contextTreeFileRowClassName(active)}
      style={{ paddingLeft: rowPaddingLeft(depth) }}
      title={title}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className="focus-ring flex min-w-0 flex-1 items-center self-stretch rounded-md text-left"
      >
        <RowIcon icon={icon} />
        <span className="ml-0.5 min-w-0 flex-1 truncate">{name}</span>
      </button>
    </div>
  );
}

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
      className={cn("py-1.5 pr-2 leading-snug", role.hint)}
      style={{ paddingLeft: ROW_INSET_PX + rowPaddingLeft(1) }}
    >
      {children}
    </p>
  );
}

/** The `mx-2` a row sits inside its list with. */
const ROW_INSET_PX = 8;

/** Error row with a retry link, shown when a rail section fails to load. */
export function RailErrorRow({ onRetry, label }: { onRetry: () => void; label: ReactNode }) {
  return <InlineErrorRow message={label} onRetry={onRetry} />;
}
