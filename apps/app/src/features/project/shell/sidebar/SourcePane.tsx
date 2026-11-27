import { type HTMLAttributes, type ReactNode, useRef } from "react";
import { ListSectionHeader } from "@/components/ui/list-section";
import { dragPayloadKind } from "@/core/editor/landing/drag-payload";
import { dragEdgeScroll } from "@/core/editor/landing/edge-scroll";
import { DropRegion } from "../../context/tree-drop/DropRegion";
import type { TreeDropState } from "../../context/tree-drop/tree-drop";

export type SourceDrop = {
  dropProps: HTMLAttributes<HTMLElement>;
  dropState: TreeDropState;
};

export function SourcePane({
  label,
  title,
  actions,
  search,
  bar,
  notice,
  drop,
  children,
}: {
  label: string;
  title?: string;
  actions?: ReactNode;
  search?: ReactNode;
  bar?: ReactNode;
  notice?: ReactNode;
  drop?: SourceDrop;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <DropRegion state={drop?.dropState ?? "idle"} className="flex min-h-0 flex-1 flex-col">
      <div {...drop?.dropProps} className="flex min-h-0 flex-1 flex-col">
        {search ? <div className="shrink-0 px-2 pb-1">{search}</div> : null}
        <ListSectionHeader
          level={2}
          label={label}
          title={title}
          actions={
            notice || actions ? (
              <>
                {notice}
                {actions}
              </>
            ) : undefined
          }
        />
        {bar ? <div className="mx-2 flex shrink-0 items-center justify-end pb-1">{bar}</div> : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: scrolling at the edges while dragging. slop-lint: allow suppression the reason is stated in this comment */}
        <div
          ref={scroller}
          onDragOver={(event) => {
            if (dragPayloadKind(Array.from(event.dataTransfer.types)) !== "none")
              dragEdgeScroll(scroller.current, event.clientY);
          }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2"
        >
          {children}
        </div>
      </div>
    </DropRegion>
  );
}
