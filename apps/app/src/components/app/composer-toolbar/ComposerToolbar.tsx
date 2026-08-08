import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowLeft, ChevronRight, Ellipsis } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const overflow = controls.filter(({ id }) => layout.overflowIds.includes(id));
  const active = overflow.find(({ id }) => id === page);
  useEffect(() => {
    if (!overflow.length) {
      setOpen(false);
      setPage(null);
    } else if (page && !overflow.some(({ id }) => id === page)) setPage(null);
  }, [overflow.length, page]);
  const busy = active?.overflow.busy === true;
  const dismissible = active?.overflow.canDismiss !== false;
  return (
    <div
      ref={root}
      role="toolbar"
      aria-label={ariaLabel}
      className="relative flex min-w-0 items-center gap-2 overflow-clip"
    >
      {controls.map((control) => {
        const hidden = layout.overflowIds.includes(control.id);
        return (
          <span
            key={control.id}
            ref={controlRef(control.id)}
            inert={hidden ? true : undefined}
            aria-hidden={hidden || undefined}
            className={cn(
              "inline-flex w-max flex-none",
              hidden && "pointer-events-none invisible absolute left-0 top-0",
            )}
          >
            {control.inline}
          </span>
        );
      })}
      {overflow.length ? (
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (!next && !dismissible) return;
            setOpen(next);
            if (!next) setPage(null);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="quiet"
              size="icon-lg"
              type="button"
              aria-label={t`More composer controls`}
              aria-busy={busy}
            >
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            aria-busy={busy}
            className={cn(
              "composer-overflow-surface flex flex-col overflow-hidden",
              active?.overflow.size === "picker" ? "w-80 p-3" : "w-56 p-1",
            )}
            onEscapeKeyDown={(event) => {
              if (!dismissible) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (!dismissible) event.preventDefault();
            }}
          >
            {active ? (
              <>
                <Button
                  variant="quiet"
                  className="mb-1 min-h-11 justify-start"
                  disabled={busy}
                  onClick={() => {
                    active.overflow.onBack?.();
                    setPage(null);
                  }}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  <Trans>Back</Trans>
                </Button>
                {active.overflow.panel}
              </>
            ) : (
              <ul>
                {overflow.map((control) => (
                  <li key={control.id}>
                    <Button
                      variant="ghost"
                      className="min-h-11 w-full justify-start gap-2 px-2"
                      aria-label={control.overflow.ariaLabel}
                      onClick={() => {
                        if (control.overflow.panel) {
                          control.overflow.onOpen?.();
                          setPage(control.id);
                        }
                      }}
                    >
                      <span className="shrink-0">{control.overflow.label}</span>
                      {control.overflow.value ? (
                        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                          {control.overflow.value}
                        </span>
                      ) : null}
                      {control.overflow.panel ? (
                        <ChevronRight className="size-4 shrink-0" aria-hidden />
                      ) : null}
                    </Button>
                  </li>
                ))}
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
