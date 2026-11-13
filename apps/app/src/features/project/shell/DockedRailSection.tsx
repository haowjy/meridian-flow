/**
 * A section docked under a sidebar list (Scratch, under the chats): content that is not the
 * project's, kept apart from the list above it. Expanded, it is content-sized up to 40% of the
 * rail until the writer drags its top edge, which trades height with the list above. Open state
 * and height are this device's rail preferences.
 */
import { t } from "@lingui/core/macro";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { cn } from "@/lib/utils";
import { schemeLabel } from "../context/context-schemes";
import { ResizeHandle } from "../layout/ResizeHandle";
import {
  type DockedRailSectionId,
  useProjectSurfacePrefsStore,
} from "../layout/surface-prefs-store";

const MIN_PANE_PX = 120;
/** What the list above keeps however far the edge is dragged: its heading and a couple of rows. */
const MIN_ABOVE_PX = 140;

export function DockedRailSection({
  id,
  children,
}: {
  id: DockedRailSectionId;
  children: (pane: { expanded: boolean; setExpanded: (next: boolean) => void }) => ReactNode;
}) {
  const expanded = useProjectSurfacePrefsStore((state) => state.railPrefs[`${id}Expanded`]);
  const height = useProjectSurfacePrefsStore((state) => state.railPrefs[`${id}Height`]);
  const setRailExpanded = useProjectSurfacePrefsStore((state) => state.setRailExpanded);
  const setHeight = useProjectSurfacePrefsStore((state) => state.setRailHeight);
  const sectionRef = useRef<HTMLElement | null>(null);
  const heightVar = `--${id}-section-height` as const;
  return (
    <section
      ref={sectionRef}
      // A collapsed header is its content: letting it shrink would paint it over
      // the rows below once the rail runs out of height.
      className={cn(
        "relative flex flex-col border-t border-border-subtle px-2 pt-1",
        expanded ? "min-h-0 shrink" : "shrink-0",
      )}
      // The handle's variable (set live while dragging, and from the saved height)
      // replaces the content-sized default.
      style={
        expanded
          ? ({
              height: `var(${heightVar}, auto)`,
              maxHeight: `max(40%, var(${heightVar}, 0px))`,
              minHeight: height === null ? undefined : MIN_PANE_PX,
              ...(height === null ? {} : { [heightVar]: `${height}px` }),
            } as CSSProperties)
          : undefined
      }
    >
      {expanded ? (
        <ResizeHandle
          gridRef={sectionRef}
          cssVariableName={heightVar}
          widthPx={height}
          minWidthPx={MIN_PANE_PX}
          maxWidthPx={Number.MAX_SAFE_INTEGER}
          orientation="vertical"
          dragDirection={-1}
          ariaLabel={t`Resize ${schemeLabel(id)}`}
          measure={() => {
            const section = sectionRef.current;
            const own = section?.getBoundingClientRect().height ?? MIN_PANE_PX;
            const room = section?.parentElement?.getBoundingClientRect().height ?? own;
            return {
              value: own,
              min: MIN_PANE_PX,
              max: Math.max(MIN_PANE_PX, room - MIN_ABOVE_PX),
            };
          }}
          onCommit={(next) => setHeight(id, next)}
          onReset={() => setHeight(id, null)}
        />
      ) : null}
      {children({ expanded, setExpanded: (next) => setRailExpanded(id, next) })}
    </section>
  );
}
