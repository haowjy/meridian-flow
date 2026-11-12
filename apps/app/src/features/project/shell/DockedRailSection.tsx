/**
 * A section docked above the rail's account row (Scratch): content that is not the project's,
 * kept apart from the project tree above it. Expanded, it is content-sized up to 40% of the
 * rail. Its open state is this device's rail preference.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type RailSectionId, useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";

export function DockedRailSection({
  id,
  children,
}: {
  id: RailSectionId;
  children: (pane: { expanded: boolean; setExpanded: (next: boolean) => void }) => ReactNode;
}) {
  const expanded = useProjectSurfacePrefsStore((state) => state.railPrefs[`${id}Expanded`]);
  const setRailExpanded = useProjectSurfacePrefsStore((state) => state.setRailExpanded);
  return (
    <section
      // A collapsed header is its content: letting it shrink would paint it over
      // the rows below once the rail runs out of height.
      className={cn(
        "relative flex flex-col border-t border-border-subtle py-1",
        expanded ? "max-h-[40%] min-h-0 shrink" : "shrink-0",
      )}
    >
      {children({ expanded, setExpanded: (next) => setRailExpanded(id, next) })}
    </section>
  );
}
