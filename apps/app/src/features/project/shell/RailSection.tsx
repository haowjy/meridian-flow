/**
 * RailSection — building blocks for the lists drawn beside the left file tree:
 * the right context rail's Recent and the left rail's Scratch. They are the
 * tree's own parts: section heads are
 * `RailPaneHeader`, file rows wear `contextTreeFileRowClassName` with the
 * tree's `RowIcon` and `Twistie`, and the empty hint takes the tree's. They
 * therefore read as the same surface as the tree.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { RowIcon, rowPaddingLeft, Twistie } from "../context/ContextTreeRows";
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
        <span className="h-7 w-4 shrink-0" aria-hidden />
        <RowIcon icon={icon} />
        <span className="ml-0.5 min-w-0 flex-1 truncate">{name}</span>
      </button>
    </div>
  );
}

/** One folder row, as the tree draws it: a twistie, the folder glyph and its name. */
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
        <Twistie expanded={expanded} />
        <RowIcon icon={icon} />
        <span className="ml-0.5 min-w-0 flex-1 truncate">{name}</span>
      </button>
    </div>
  );
}

/** Muted placeholder shown when a rail section is empty, indented like a tree row. */
export function RailEmptyHint({ children }: { children: ReactNode }) {
  return <p className="py-1.5 pr-2 pl-6 text-xs leading-snug text-ink-subtle">{children}</p>;
}

/** Error row with a retry link, shown when a rail section fails to load. */
export function RailErrorRow({ onRetry, label }: { onRetry: () => void; label: ReactNode }) {
  return <InlineErrorRow message={label} onRetry={onRetry} />;
}
