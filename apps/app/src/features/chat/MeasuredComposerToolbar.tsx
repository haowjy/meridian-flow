/** Width-driven composer toolbar with priority overflow and one compact drill-in menu. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowLeft, Ellipsis } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ComposerToolbarControl = {
  id: string;
  priority: number;
  inline: ReactNode;
  overflow?: {
    label: ReactNode;
    onOpen: () => void;
    panel: ReactNode;
    panelOpen: boolean;
    onBack: () => void;
  };
};

export function MeasuredComposerToolbar({
  controls,
  overflowOpen,
  onOverflowOpenChange,
  onLayout,
  busy,
  canDismiss,
}: {
  controls: ComposerToolbarControl[];
  overflowOpen: boolean;
  onOverflowOpenChange: (open: boolean) => void;
  onLayout: (layout: "direct" | "overflow") => void;
  busy: boolean;
  canDismiss: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const widthById = useRef(new Map<string, number>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const controlSignature = controls.map(({ id, priority }) => `${id}:${priority}`).join("|");
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      for (const node of root.querySelectorAll<HTMLElement>("[data-toolbar-control]")) {
        const id = node.dataset.toolbarControl;
        if (id) widthById.current.set(id, node.getBoundingClientRect().width);
      }
      const widths = controls.map((control) => widthById.current.get(control.id) ?? 0);
      let required =
        widths.reduce((sum, width) => sum + width, 0) + Math.max(0, controls.length - 1) * 8;
      const next = new Set<string>();
      for (const control of [...controls]
        .filter(({ overflow }) => overflow)
        .sort((a, b) => a.priority - b.priority)) {
        if (required <= root.clientWidth) break;
        next.add(control.id);
        required -= (widthById.current.get(control.id) ?? 0) + 8;
        if (next.size === 1) required += 40;
      }
      setHidden((current) =>
        current.size === next.size && [...current].every((id) => next.has(id)) ? current : next,
      );
      onLayout(next.size ? "overflow" : "direct");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const node of root.querySelectorAll<HTMLElement>("[data-toolbar-control]"))
      observer.observe(node);
    return () => observer.disconnect();
  }, [controlSignature, controls, onLayout]);

  const hiddenControls = controls.filter(({ id }) => hidden.has(id));
  const active = hiddenControls.find(({ overflow }) => overflow?.panelOpen)?.overflow;
  return (
    <div ref={rootRef} className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
      {controls.map((control) =>
        hidden.has(control.id) ? null : (
          <span
            key={control.id}
            data-toolbar-control={control.id}
            className="flex shrink-0 items-center"
          >
            {control.inline}
          </span>
        ),
      )}
      {hiddenControls.length ? (
        <Popover open={overflowOpen} onOpenChange={onOverflowOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="quiet"
              size="icon-lg"
              type="button"
              aria-label={t`More composer settings`}
              aria-busy={busy}
            >
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label={t`Composer settings`}
            aria-busy={busy}
            className={cn(
              "flex flex-col overflow-hidden p-2",
              active ? "work-selector-popover w-80" : "w-56",
            )}
            onEscapeKeyDown={(event) => {
              if (!canDismiss) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (!canDismiss) event.preventDefault();
            }}
          >
            {active ? (
              <>
                <Button
                  variant="quiet"
                  type="button"
                  disabled={busy}
                  className="mb-2 min-h-11 justify-start px-1"
                  onClick={active.onBack}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  <Trans>Back</Trans>
                </Button>
                {active.panel}
              </>
            ) : (
              <div className="space-y-1">
                {hiddenControls.map((control) => (
                  <Button
                    key={control.id}
                    variant="ghost"
                    type="button"
                    autoFocus
                    disabled={busy}
                    className="min-h-11 w-full justify-start px-2"
                    onClick={control.overflow?.onOpen}
                  >
                    {control.overflow?.label}
                  </Button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
