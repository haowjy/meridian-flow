/**
 * A section docked above the rail's account row (User, Scratch): content that
 * is not the project's, kept apart from the project tree above it. Expanded,
 * it is content-sized up to 40% of the rail, and on desktop a handle on its
 * divider trades height with the pane above. Open state and height are this
 * device's rail preferences.
 */
import { t } from "@lingui/core/macro";
import { type CSSProperties, type ReactNode, type RefObject, useRef } from "react";
import { schemeLabel } from "../context/context-schemes";
import { ResizeHandle } from "../layout/ResizeHandle";
import {
  type DockedRailSectionId,
  useProjectSurfacePrefsStore,
} from "../layout/surface-prefs-store";

const MIN_PANE_PX = 120;

export function DockedRailSection({
  id,
  resizeAgainst,
  children,
}: {
  id: DockedRailSectionId;
  /** Desktop only: the pane above, which the handle trades height with. */
  resizeAgainst?: RefObject<HTMLElement | null>;
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
      className="relative flex min-h-0 shrink flex-col border-t border-border-subtle py-1"
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
      {resizeAgainst && expanded ? (
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
            const own = sectionRef.current?.getBoundingClientRect().height ?? MIN_PANE_PX;
            const above = resizeAgainst.current?.getBoundingClientRect().height ?? 0;
            return { value: own, min: MIN_PANE_PX, max: own + above - MIN_PANE_PX };
          }}
          onCommit={(next) => setHeight(id, next)}
          onReset={() => setHeight(id, null)}
        />
      ) : null}
      {children({ expanded, setExpanded: (next) => setRailExpanded(id, next) })}
    </section>
  );
}
