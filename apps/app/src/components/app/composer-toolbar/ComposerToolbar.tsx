import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowLeft, ChevronRight, Ellipsis } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ComposerToolbarControl } from "./types";
import { useMeasuredComposerToolbar } from "./useMeasuredComposerToolbar";

export function ComposerToolbar({
  controls,
  ariaLabel,
}: {
  controls: readonly ComposerToolbarControl[];
  ariaLabel: string;
}) {
  const { root, probe, controlRef, layout } = useMeasuredComposerToolbar(controls);
  const [rootOpen, setRootOpen] = useState(false);
  const [suppressedPanelId, setSuppressedPanelId] = useState<string | null>(null);
  const drillingIn = useRef(false);
  const overflow = controls.filter(({ id }) => layout.overflowIds.includes(id));
  const openControl = controls.find(
    (control) => control.overflow.kind === "panel" && control.overflow.panel.open,
  );
  const overflowPanel = overflow.find(
    ({ id }) => id === openControl?.id && id !== suppressedPanelId,
  );
  const activePanel =
    overflowPanel?.overflow.kind === "panel" ? overflowPanel.overflow.panel : null;

  useEffect(() => {
    if (!openControl) setSuppressedPanelId(null);
    if (activePanel) setRootOpen(true);
    else if (openControl) setRootOpen(false);
    if (!overflow.length) setRootOpen(false);
  }, [activePanel, openControl, overflow.length]);

  const requestPanelOpen = (control: ComposerToolbarControl) => {
    if (control.overflow.kind !== "panel") return;
    setSuppressedPanelId(null);
    if (openControl && openControl.id !== control.id && openControl.overflow.kind === "panel") {
      if (!openControl.overflow.panel.canDismiss) return;
      openControl.overflow.panel.onRequestDismiss();
    }
    if (layout.overflowIds.includes(control.id)) {
      drillingIn.current = true;
      setRootOpen(true);
    }
    control.overflow.panel.onRequestOpen();
  };
  return (
    <div
      ref={root}
      role="toolbar"
      aria-label={ariaLabel}
      className="relative flex min-w-0 items-center gap-2 overflow-clip"
    >
      {controls.map((control) => {
        const hidden = layout.overflowIds.includes(control.id);
        const panel = control.overflow.kind === "panel" ? control.overflow.panel : null;
        return (
          <Popover
            key={control.id}
            open={!hidden && panel?.open === true}
            onOpenChange={(next) => {
              if (!panel) return;
              if (next) requestPanelOpen(control);
              else if (panel.canDismiss) panel.onRequestDismiss();
            }}
          >
            <PopoverAnchor asChild>
              <span
                ref={controlRef(control.id)}
                inert={hidden ? true : undefined}
                aria-hidden={hidden || undefined}
                className={cn(
                  "inline-flex w-max flex-none",
                  hidden && "pointer-events-none invisible absolute left-0 top-0",
                )}
              >
                {control.inline({
                  open: panel?.open ?? false,
                  busy: panel?.busy ?? false,
                  requestOpen: () => requestPanelOpen(control),
                  requestDismiss: () => panel?.onRequestDismiss(),
                })}
              </span>
            </PopoverAnchor>
            {panel ? <ToolbarContent panel={panel} host="inline" /> : null}
          </Popover>
        );
      })}
      {overflow.length ? (
        <Popover
          open={rootOpen}
          onOpenChange={(next) => {
            if (!next && drillingIn.current) {
              drillingIn.current = false;
              return;
            }
            if (!next && activePanel && !activePanel.canDismiss) return;
            setRootOpen(next);
            if (!next && activePanel) activePanel.onRequestDismiss();
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="quiet"
              size="icon-lg"
              type="button"
              aria-label={t`More composer controls`}
              aria-busy={activePanel?.busy}
            >
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            aria-busy={activePanel?.busy}
            data-page={activePanel ? "panel" : "root"}
            className={cn(
              "composer-overflow-surface flex flex-col overflow-hidden",
              activePanel?.size === "picker"
                ? "[--composer-overflow-page-size:20rem] p-3"
                : "[--composer-overflow-page-size:14rem] p-1",
            )}
            onEscapeKeyDown={(event) => {
              if (activePanel && !activePanel.canDismiss) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (activePanel && !activePanel.canDismiss) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              if (activePanel && !activePanel.canDismiss) event.preventDefault();
            }}
          >
            {activePanel && overflowPanel ? (
              <>
                <Button
                  variant="quiet"
                  className="mb-1 min-h-11 justify-start"
                  disabled={activePanel.busy}
                  onClick={() => {
                    if (!activePanel.canDismiss) return;
                    drillingIn.current = true;
                    setRootOpen(true);
                    setSuppressedPanelId(overflowPanel.id);
                    activePanel.onRequestDismiss();
                  }}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  <Trans>Back</Trans>
                </Button>
                {activePanel.render({
                  host: "overflow",
                  requestDismiss: activePanel.onRequestDismiss,
                })}
              </>
            ) : (
              <ul>
                {overflow.map((control) => {
                  const item = control.overflow.item;
                  return (
                    <li key={control.id}>
                      <Button
                        variant="ghost"
                        className="min-h-11 w-full justify-start gap-2 px-2"
                        aria-label={item.ariaLabel}
                        disabled={
                          openControl?.overflow.kind === "panel" &&
                          !openControl.overflow.panel.canDismiss
                        }
                        onClick={() => requestPanelOpen(control)}
                      >
                        {item.icon}
                        <span className="shrink-0">{item.label}</span>
                        {item.value ? (
                          <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                            {item.value}
                          </span>
                        ) : null}
                        {control.overflow.kind === "panel" ? (
                          <ChevronRight className="size-4 shrink-0" aria-hidden />
                        ) : null}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      ) : null}
      <Button
        ref={probe}
        variant="quiet"
        size="icon-lg"
        type="button"
        tabIndex={-1}
        inert
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0"
      >
        <Ellipsis className="size-4" />
      </Button>
    </div>
  );
}

function ToolbarContent({
  panel,
  host,
}: {
  panel: Extract<ComposerToolbarControl["overflow"], { kind: "panel" }>["panel"];
  host: "inline" | "overflow";
}) {
  return (
    <PopoverContent
      align="start"
      side="top"
      aria-label={panel.ariaLabel}
      aria-busy={panel.busy}
      className={cn(
        "composer-overflow-surface flex flex-col overflow-hidden p-3",
        panel.size === "picker"
          ? "[--composer-overflow-page-size:20rem]"
          : "[--composer-overflow-page-size:14rem]",
      )}
      onEscapeKeyDown={(event) => {
        if (!panel.canDismiss) event.preventDefault();
      }}
      onPointerDownOutside={(event) => {
        if (!panel.canDismiss) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        if (panel.open) event.preventDefault();
      }}
    >
      {panel.render({ host, requestDismiss: panel.onRequestDismiss })}
    </PopoverContent>
  );
}
