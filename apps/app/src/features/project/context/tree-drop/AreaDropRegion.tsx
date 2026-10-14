/**
 * An area as one drop target: its header and its whole list light together, and
 * a drop anywhere on them files at the area's top level. Hovering a collapsed
 * area's header opens it.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type React from "react";
import { useMemo } from "react";
import { DropRegion } from "./DropRegion";
import { type TreeDropTarget, useTreeDropTarget } from "./tree-drop";

export function AreaDropRegion({
  scheme,
  catalogRootId,
  onSpring,
  header,
  className,
  children,
}: {
  scheme: ProjectContextTreeScheme;
  /** Null until the area's catalog loads; the header is not a target before then. */
  catalogRootId: string | null;
  onSpring: () => void;
  header: (dropProps: React.HTMLAttributes<HTMLElement>) => React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const target = useMemo<TreeDropTarget>(
    () => ({ scheme, catalogRootId: catalogRootId ?? `${scheme}:loading`, folder: null }),
    [scheme, catalogRootId],
  );
  const drop = useTreeDropTarget(target, { onSpring });
  return (
    <DropRegion state={drop.dropState} className={className}>
      {header(drop.dropProps)}
      {children}
    </DropRegion>
  );
}
